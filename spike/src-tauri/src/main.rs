//! LocalBridge/Neelima Phase-0 spike: proves the four feasibility requirements
//! with an automated self-test (`--selftest --run N --report path.md`):
//!   T1  main UI webview + provider child webview coexist in ONE window
//!       (tauri multiwebview; requires the `unstable` feature)
//!   T2  initialization_script runs in both webviews and posts hello through
//!       the narrow lb_bridge channel (capability-gated)
//!   T3  eval round-trip into the provider page (RPC)
//!   T4  ACL: the provider page CANNOT call other app commands; the ui page CAN
//!   T5  DOM automation: controlled textarea + contenteditable + send click,
//!       MutationObserver completion, extraction tolerating copy-button noise
//!   T6  per-profile persistent data directory (storage marker survives
//!       destroy/remount within a session and app restarts across runs)
//!   T7  lifecycle: hide/show/resize/move/destroy + remount
//!   T8  remote https page (example.com) with the remote capability
//! The report is written as markdown and the app exits (code 0 on all-pass).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{atomic::{AtomicU64, Ordering}, Mutex},
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Webview, WebviewBuilder, WebviewUrl, WindowBuilder};

const BRIDGE_JS: &str = include_str!("bridge.js");
const HELLO_TIMEOUT: Duration = Duration::from_secs(25);
const RPC_TIMEOUT: Duration = Duration::from_secs(30);

static SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
struct SpikeState {
    pending: Mutex<HashMap<String, tokio::sync::oneshot::Sender<Value>>>,
    hellos: Mutex<HashMap<String, Value>>,
}

#[derive(Clone, Serialize)]
struct TestResult {
    name: String,
    status: String, // PASS | FAIL | SKIP
    detail: String,
    ms: u64,
}

struct Opts {
    selftest: bool,
    run: u32,
    report: PathBuf,
    remote_url: String,
}

fn opts_from_args() -> Opts {
    let args: Vec<String> = std::env::args().collect();
    let val = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1).cloned());
    Opts {
        selftest: args.iter().any(|a| a == "--selftest"),
        run: val("--run").and_then(|s| s.parse().ok()).unwrap_or(1),
        report: val("--report").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("spike-report.md")),
        remote_url: val("--remote-url").unwrap_or_else(|| "https://example.com/".into()),
    }
}

#[tauri::command]
fn lb_bridge(webview: Webview, state: tauri::State<'_, std::sync::Arc<SpikeState>>, msg: String) -> Result<(), String> {
    let label = webview.label().to_string();
    if label != "provider" && label != "ui" && label != "provider-remote" {
        return Err(format!("unexpected caller '{label}'"));
    }
    if msg.len() > 512 * 1024 {
        return Err("payload too large".into());
    }
    let v: Value = serde_json::from_str(&msg).map_err(|e| format!("bad json: {e}"))?;
    match v.get("t").and_then(Value::as_str) {
        Some("hello") => {
            state.hellos.lock().unwrap().insert(label, v);
            Ok(())
        }
        Some("rpc_result") => {
            let id = v.get("id").and_then(Value::as_str).ok_or("missing id")?.to_string();
            let raw = v.get("v").and_then(Value::as_str).unwrap_or("null");
            let val: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
            if let Some(tx) = state.pending.lock().unwrap().remove(&id) {
                let _ = tx.send(val);
            }
            Ok(())
        }
        _ => Err("unknown message type".into()),
    }
}

#[tauri::command]
fn spike_action(webview: Webview, app: AppHandle, action: String, arg: String) -> Result<Value, String> {
    let label = webview.label().to_string();
    match action.as_str() {
        // Intentionally not label-checked: T4 measures whether the ACL alone
        // blocks this from the provider webview.
        "probe_forbidden" => Ok(json!({"reached": true, "caller": label})),
        "echo" => Ok(json!({"echo": arg, "caller": label})),
        "run_selftest" => {
            let o = opts_from_args();
            let report = if arg.is_empty() { o.report } else { PathBuf::from(arg) };
            tauri::async_runtime::spawn(run_selftest(app, Opts { selftest: true, run: o.run, report, remote_url: o.remote_url }));
            Ok(json!({"started": true}))
        }
        _ if label != "ui" => Err(format!("not allowed from webview '{label}'")),
        _ => Err(format!("unknown action '{action}'")),
    }
}

async fn rpc(app: &AppHandle, label: &str, method: &str, arg_json: &str, state: &SpikeState) -> Result<Value, String> {
    let id = format!("r{}", SEQ.fetch_add(1, Ordering::Relaxed));
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.pending.lock().unwrap().insert(id.clone(), tx);
    let wv = app.get_webview(label).ok_or_else(|| format!("webview '{label}' missing"))?;
    let js = format!(
        "window.__LB_SPIKE__ && window.__LB_SPIKE__.call({:?}, {:?}, {:?})",
        method, arg_json, id
    );
    wv.eval(js).map_err(|e| format!("eval failed: {e}"))?;
    match tokio::time::timeout(RPC_TIMEOUT, rx).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(_)) => Err("rpc channel dropped".into()),
        Err(_) => Err(format!("rpc '{method}' timed out")),
    }
}

async fn wait_hello(app: &AppHandle, label: &str, state: &SpikeState) -> Value {
    let deadline = Instant::now() + HELLO_TIMEOUT;
    loop {
        if let Some(v) = state.hellos.lock().unwrap().get(label).cloned() {
            return v;
        }
        if Instant::now() > deadline {
            return json!({"t": "timeout"});
        }
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
}

struct Run {
    app: AppHandle,
    out: Vec<TestResult>,
}

impl Run {
    async fn test(&mut self, name: &str, fut: impl std::future::Future<Output = (bool, String)>) {
        let t0 = Instant::now();
        let (ok, detail) = fut.await;
        let status = if ok { "PASS" } else { "FAIL" };
        self.out.push(TestResult { name: name.into(), status: status.into(), detail, ms: t0.elapsed().as_millis() as u64 });
        let _ = self.app.emit("spike-log", json!({"name": name, "status": status, "detail": ""}));
    }
}

fn app_data(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."))
}

async fn run_selftest(app: AppHandle, opts: Opts) {
    let watchdog_app = app.clone();
    let report_path = opts.report.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(240)).await;
        let _ = fs::write(&report_path, "# Spike self-test: WATCHDOG TIMEOUT\n");
        watchdog_app.exit(2);
    });

    let state: std::sync::Arc<SpikeState> = app.state::<std::sync::Arc<SpikeState>>().inner().clone();
    let mut r = Run { app: app.clone(), out: Vec::new() };
    let run_no = opts.run;

    r.test("T1 one window hosts ui + provider webviews (multiwebview, unstable)", {
            let app = app.clone();
            let state = state.clone();
            async move {
        let ui = app.get_webview("ui").is_some();
        let prov = app.get_webview("provider").is_some();
        let n = app_webviews(&app);
        (ui && prov && n >= 2, format!("ui present: {ui}, provider present: {prov}, webviews on 'main': {n}"))
            }
        }).await;

    r.test("T2 init script + hello via narrow lb_bridge (ui webview)", {
            let app = app.clone();
            let state = state.clone();
            async move {
        let h = wait_hello(&app, "ui", &state).await;
        (h.get("has_ipc") == Some(&json!(true)), format!("{h}"))
            }
        }).await;
    r.test("T2b init script + hello via narrow lb_bridge (provider webview)", {
            let app = app.clone();
            let state = state.clone();
            async move {
        let h = wait_hello(&app, "provider", &state).await;
        (h.get("has_ipc") == Some(&json!(true)), format!("{h}"))
            }
        }).await;

    r.test("T3 eval round-trip: ping provider page", {
            let app = app.clone();
            let state = state.clone();
            async move {
        match rpc(&app, "provider", "ping", "null", &state).await {
            Ok(v) => {
                let s = v["value"].as_str().unwrap_or("").to_string();
                (s.starts_with("pong:"), s)
            }
            Err(e) => (false, e),
        }
            }
        }).await;

    r.test("T4a ACL blocks spike_action from the provider webview", {
            let app = app.clone();
            let state = state.clone();
            async move {
        match rpc(&app, "provider", "probe_forbidden", "null", &state).await {
            Ok(v) => {
                let s = v["value"].as_str().unwrap_or("").to_string();
                let blocked = s.starts_with("blocked-as-expected");
                (blocked, s)
            }
            Err(e) => (false, format!("rpc failed: {e}")),
        }
            }
        }).await;
    r.test("T4b ui webview IS allowed to call spike_action (positive control)", {
            let app = app.clone();
            let state = state.clone();
            async move {
        match rpc(&app, "ui", "probe_allowed", "null", &state).await {
            Ok(v) => {
                let s = v["value"].as_str().unwrap_or("").to_string();
                (s.starts_with("allowed:"), s)
            }
            Err(e) => (false, format!("rpc failed: {e}")),
        }
            }
        }).await;

    r.test("T5a DOM automation: controlled textarea + send + observer completion + extraction", {
            let app = app.clone();
            let state = state.clone();
            async move {
        let text = format!("spike-ta-{run_no}");
        let send_arg = json!({"strategy": "textarea", "text": text}).to_string();
        let _ = rpc(&app, "provider", "demo_send", &send_arg, &state).await;
        let _ = rpc(&app, "provider", "demo_wait_response", &json!({"quiet_ms": 700}).to_string(), &state).await;
        match rpc(&app, "provider", "demo_get_last_assistant", "null", &state).await {
            Ok(v) => {
                let s = v["value"].as_str().unwrap_or("").to_string();
                let ok = s.contains(&text) && s.contains("read_file") && s.contains("Copy");
                (ok, if ok { format!("extracted: {}", s.chars().take(120).collect::<String>()) } else { s.chars().take(300).collect() })
            }
            Err(e) => (false, e),
        }
            }
        }).await;
    r.test("T5b DOM automation: contenteditable path", {
            let app = app.clone();
            let state = state.clone();
            async move {
        let text = format!("spike-ce-{run_no}");
        let send_arg = json!({"strategy": "contenteditable", "text": text}).to_string();
        let _ = rpc(&app, "provider", "demo_send", &send_arg, &state).await;
        let _ = rpc(&app, "provider", "demo_wait_response", &json!({"quiet_ms": 700}).to_string(), &state).await;
        match rpc(&app, "provider", "demo_get_last_assistant", "null", &state).await {
            Ok(v) => {
                let s = v["value"].as_str().unwrap_or("").to_string();
                (s.contains(&text), s.chars().take(200).collect())
            }
            Err(e) => (false, e),
        }
            }
        }).await;

    r.test("T6 per-profile data directory: storage marker persists across destroy/remount", {
            let app = app.clone();
            let state = state.clone();
            async move {
        let before = rpc(&app, "provider", "get_marker", "null", &state).await
            .ok().and_then(|v| v["value"].as_str().map(String::from)).unwrap_or_default();
        let marker = format!("lb-spike-run{run_no}");
        let _ = rpc(&app, "provider", "set_marker", &json!(marker).to_string(), &state).await;
        if let Some(wv) = app.get_webview("provider") { let _ = wv.close(); }
        wait_gone(&app, "provider").await;
        match remount_provider(&app).await {
            Ok(_) => {
                // give the fresh page a moment to run its init script
                tokio::time::sleep(Duration::from_millis(800)).await;
                let after = rpc(&app, "provider", "get_marker", "null", &state).await
                    .ok().and_then(|v| v["value"].as_str().map(String::from)).unwrap_or_default();
                let persisted = after == marker;
                (persisted, format!("marker after remount: {after:?}; from previous app run: {before:?}"))
            }
            Err(e) => (false, format!("remount failed: {e}")),
        }
            }
        }).await;

    r.test("T7 webview lifecycle: hide/show/resize/move then ping", {
            let app = app.clone();
            let state = state.clone();
            async move {
        let wv = match app.get_webview("provider") { Some(w) => w, None => return (false, "provider webview missing".into()) };
        let mut detail = String::new();
        let mut ok = true;
        if wv.hide().is_err() { ok = false; detail.push_str("hide failed; "); }
        if wv.show().is_err() { ok = false; detail.push_str("show failed; "); }
        if wv.set_size(LogicalSize::new(900.0, 320.0)).is_err() { ok = false; detail.push_str("set_size failed; "); }
        if wv.set_position(LogicalPosition::new(20.0, 430.0)).is_err() { ok = false; detail.push_str("set_position failed; "); }
        let ping = rpc(&app, "provider", "ping", "null", &state).await
            .ok().and_then(|v| v["value"].as_str().map(String::from)).unwrap_or_default();
        ok = ok && ping.starts_with("pong:");
        detail.push_str(&format!("post-lifecycle ping: {ping}"));
        (ok, detail)
            }
        }).await;

    r.test("T8 remote https page loads with init script + capability-gated IPC", {
            let app = app.clone();
            let state = state.clone();
            async move {
        let url = opts.remote_url.clone();
        let parsed = match tauri::Url::parse(&url) { Ok(u) => u, Err(e) => return (false, format!("bad url: {e}")) };
        let wv = WebviewBuilder::new("provider-remote", WebviewUrl::External(parsed))
            .initialization_script(BRIDGE_JS)
            .data_directory(app_data(&app).join("provider-profiles").join("remote-default"));
        let win = match app.get_window("main") { Some(w) => w, None => return (false, "no main window".into()) };
        if let Err(e) = win.add_child(wv, LogicalPosition::new(20.0, 430.0), LogicalSize::new(900.0, 320.0)) {
            return (false, format!("add_child failed: {e}"));
        }
        let h = wait_hello(&app, "provider-remote", &state).await;
        let hello_ok = h.get("has_ipc") == Some(&json!(true));
        let ping = rpc(&app, "provider-remote", "ping", "null", &state).await
            .ok().and_then(|v| v["value"].as_str().map(String::from)).unwrap_or_default();
        if let Some(w) = app.get_webview("provider-remote") { let _ = w.close(); }
        (hello_ok && ping.starts_with("pong:"), format!("hello: {h}; ping: {ping}"))
            }
        }).await;

    // ---- write report ----
    let mut md = String::new();
    md.push_str("# LocalBridge/Neelima Phase-0 spike self-test report\n\n");
    md.push_str(&format!("- date: {}\n", chrono_stamp()));
    md.push_str(&format!("- OS: {} {}\n", std::env::consts::OS, std::env::consts::ARCH));
    md.push_str(&format!("- tauri: {} (unstable multiwebview)\n", tauri::VERSION));
    md.push_str(&format!("- run: {} (run 1 seeds the storage marker; run 2 verifies restart persistence)\n\n", run_no));
    md.push_str("| # | test | status | ms | detail |\n|---|------|--------|----|--------|\n");
    let mut all_pass = true;
    for (i, t) in r.out.iter().enumerate() {
        if t.status != "PASS" { all_pass = false; }
        md.push_str(&format!("| {} | {} | {} | {} | {} |\n", i + 1, t.name, t.status, t.ms, t.detail.replace('|', "\\|")));
    }
    md.push_str(&format!("\nOverall: **{}**\n", if all_pass { "ALL PASS" } else { "FAILURES PRESENT" }));
    let _ = fs::write(&opts.report, &md);
    println!("{}", md);
    app.exit(if all_pass { 0 } else { 1 });
}

fn app_webviews(app: &AppHandle) -> usize {
    app.get_window("main").map(|w| w.webviews().len()).unwrap_or(0)
}

async fn wait_gone(app: &AppHandle, label: &str) {
    for _ in 0..50 {
        if app.get_webview(label).is_none() { return; }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn remount_provider(app: &AppHandle) -> Result<(), String> {
    let win = app.get_window("main").ok_or("no main window")?;
    let dir = app_data(app).join("provider-profiles").join("default");
    let wv = WebviewBuilder::new("provider", WebviewUrl::App("demo-chat.html".into()))
        .initialization_script(BRIDGE_JS)
        .data_directory(dir);
    win.add_child(wv, LogicalPosition::new(20.0, 430.0), LogicalSize::new(900.0, 320.0))
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn chrono_stamp() -> String {
    let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    format!("unix timestamp {}", d)
}

fn main() {
    let opts = opts_from_args();
    tauri::Builder::default()
        .manage(std::sync::Arc::new(SpikeState::default()))
        .invoke_handler(tauri::generate_handler![lb_bridge, spike_action])
        .setup(move |app| {
            let handle = app.handle().clone();
            let window = WindowBuilder::new(&handle, "main")
                .title("Neelima Phase-0 Spike")
                .inner_size(1000.0, 800.0)
                .build()?;
            let data_dir = app_data(&handle).join("provider-profiles").join("default");
            fs::create_dir_all(&data_dir).ok();

            window.add_child(
                WebviewBuilder::new("ui", WebviewUrl::App("index.html".into())).initialization_script(BRIDGE_JS),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(1000.0, 400.0),
            )?;
            window.add_child(
                WebviewBuilder::new("provider", WebviewUrl::App("demo-chat.html".into()))
                    .initialization_script(BRIDGE_JS)
                    .data_directory(data_dir),
                LogicalPosition::new(20.0, 430.0),
                LogicalSize::new(900.0, 320.0),
            )?;

            if opts.selftest {
                let app2 = handle.clone();
                let o2 = Opts { selftest: true, run: opts.run, report: opts.report.clone(), remote_url: opts.remote_url.clone() };
                tauri::async_runtime::spawn(async move { run_selftest(app2, o2).await });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("spike failed to run");
}
