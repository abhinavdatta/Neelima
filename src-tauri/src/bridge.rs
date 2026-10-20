//! The narrow provider bridge: ONE command (`lb_bridge`) reachable from the
//! provider webview, granted via a capability that contains nothing else.
//!
//! The page may only ever report: hello, ready, login_state, assistant_message,
//! rpc_result. It can NEVER read or write files — all file/tool work flows from
//! the agent loop (Rust) to the page via eval, never the other way around.
//!
//! Security: every bridge message is bound to a per-mount random nonce and a
//! host allowlist. RPC results and assistant messages are restricted to the
//! provider's primary origin; auth hosts may only report load/login state.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde_json::Value;
use tauri::{Manager, State};
use tokio::sync::oneshot;

pub const MAX_BRIDGE_MSG: usize = 512 * 1024;

/// Only these message types may arrive from the provider page. Anything else
/// is rejected — file operations from the page were removed (CC-B2/A2): the
/// page is untrusted https content and must never touch the workspace.
pub const ALLOWED_TYPES: &[&str] = &[
    "hello",
    "ready",
    "login_state",
    "assistant_message",
    "rpc_result",
];

static SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct BridgeHub {
    /// id -> (nonce, sender) for pending long-lived RPCs.
    pub pending: Mutex<HashMap<String, (String, oneshot::Sender<Value>)>>,
    /// Per-mount nonce, set by webprov on every mount. Re-randomized so a page
    /// captured before a remount cannot answer afterwards.
    pub nonce: Mutex<String>,
    /// Current mount's origin policy; cleared on unmount.
    origin: Mutex<Option<BridgeOrigin>>,
    /// Bounded ring of recent bridge events for diagnostics (bug reports).
    pub log: Mutex<Vec<String>>,
    pub log_path: Mutex<Option<PathBuf>>,
    pub log_write_error: Mutex<Option<String>>,
}

#[derive(Clone)]
struct BridgeOrigin {
    adapter_url: String,
    primary_host: String,
    auth_domains: Vec<String>,
}

impl BridgeHub {
    /// Rotate the per-mount nonce (called on every webview mount).
    pub fn new_nonce(&self) -> String {
        let n = format!("n{:032x}", uuid::Uuid::new_v4().as_u128());
        *self.nonce.lock().unwrap() = n.clone();
        self.note(format!("nonce rotated ({})", &n[..8]));
        n
    }

    pub fn current_nonce(&self) -> String {
        self.nonce.lock().unwrap().clone()
    }

    pub fn set_origin(&self, adapter_url: &str, primary_host: &str, auth_domains: &[String]) {
        *self.origin.lock().unwrap() = Some(BridgeOrigin {
            adapter_url: adapter_url.to_string(),
            primary_host: primary_host.to_string(),
            auth_domains: auth_domains.to_vec(),
        });
    }

    pub fn clear_origin(&self) {
        *self.origin.lock().unwrap() = None;
    }

    fn origin_allowed(&self, url: &tauri::Url, primary_only: bool) -> bool {
        self.origin
            .lock()
            .unwrap()
            .as_ref()
            .map(|origin| {
                crate::webprov::provider_url_allowed(
                    url,
                    &origin.adapter_url,
                    &origin.primary_host,
                    &origin.auth_domains,
                    primary_only,
                )
            })
            .unwrap_or(false)
    }

    fn note(&self, line: String) {
        {
            let mut log = self.log.lock().unwrap();
            log.push(format!("[{}] {}", crate::history::now_ms(), line));
            if log.len() > 200 {
                let over = log.len() - 200;
                log.drain(..over);
            }
        }
        self.persist_log();
    }

    pub fn set_log_path(&self, path: PathBuf) {
        *self.log_path.lock().unwrap() = Some(path);
        self.persist_log();
    }

    fn persist_log(&self) {
        let path = self.log_path.lock().unwrap().clone();
        let Some(path) = path else { return };
        let contents = self.log.lock().unwrap().join("\n");
        let result = path
            .parent()
            .map(std::fs::create_dir_all)
            .unwrap_or_else(|| Ok(()))
            .and_then(|()| std::fs::write(path, contents));
        *self.log_write_error.lock().unwrap() = result.err().map(|e| e.to_string());
    }

    pub fn log_path(&self) -> Option<PathBuf> {
        self.log_path.lock().unwrap().clone()
    }

    pub fn log_write_error(&self) -> Option<String> {
        self.log_write_error.lock().unwrap().clone()
    }

    pub fn events(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }

    /// Register a pending RPC bound to the current nonce; returns (id, nonce, rx).
    /// The Rust side evals `window.__LB__.call(method, argJson, id, nonce)`.
    pub fn begin(&self) -> (String, String, oneshot::Receiver<Value>) {
        let id = format!("r{}", SEQ.fetch_add(1, Ordering::Relaxed));
        let nonce = self.current_nonce();
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap()
            .insert(id.clone(), (nonce.clone(), tx));
        self.note(format!("rpc begin {id}"));
        (id, nonce, rx)
    }

    /// Resolve an RPC only if the id exists AND the nonce matches the mount.
    pub fn resolve(&self, id: &str, nonce: &str, value: Value) -> bool {
        let matched = {
            let mut p = self.pending.lock().unwrap();
            let keep = p.get(id).map(|(n, _)| n == nonce).unwrap_or(false);
            if keep {
                p.remove(id).map(|(_, tx)| tx)
            } else {
                None
            }
        };
        if let Some(tx) = matched {
            self.note(format!("rpc resolve {id}"));
            let _ = tx.send(value);
            true
        } else {
            self.note(format!("rejected rpc_result id={id} (bad/missing nonce)"));
            false
        }
    }

    pub fn cancel(&self, id: &str) {
        if self.pending.lock().unwrap().remove(id).is_some() {
            self.note(format!("rpc cancel {id}"));
        }
    }

    pub async fn wait(rx: oneshot::Receiver<Value>, timeout_ms: u64) -> Result<Value, String> {
        match tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(_)) => Err("bridge channel dropped (webview closed?)".into()),
            Err(_) => Err("bridge timeout".into()),
        }
    }
}

#[derive(serde::Deserialize)]
struct BridgeMsg {
    t: String,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    nonce: Option<String>,
    #[serde(default)]
    v: Option<String>,
    // login_state / assistant_message extra fields arrive inside v as JSON.
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    seq: Option<u64>,
    #[serde(default)]
    text: Option<String>,
}

/// The single intake command. Keep it boring: validate caller, parse, route.
#[tauri::command]
pub async fn lb_bridge(
    webview: tauri::Webview,
    hub: State<'_, std::sync::Arc<BridgeHub>>,
    msg: String,
) -> Result<Value, String> {
    // Only the provider webview may call this. The ui webview ("hello" from
    // local pages) was accepted before; that is also home to demo-chat via
    // app:// URLs — the demo adapter runs on the ui webview as app:// content
    // through the SAME provider label. Keep strictly to "provider".
    let label = webview.label().to_string();
    if label != "provider" {
        return Err(format!("lb_bridge: unexpected caller webview '{label}'"));
    }
    if hub.log_path().is_none() {
        if let Ok(path) = webview
            .app_handle()
            .path()
            .app_data_dir()
            .map(|dir| dir.join("provider-bridge.log"))
        {
            hub.set_log_path(path);
        }
    }
    if msg.len() > MAX_BRIDGE_MSG {
        // Note but don't fail hard on size — reject politely.
        hub.note(format!("oversized message: {} bytes", msg.len()));
        return Err(format!(
            "lb_bridge: message exceeds {} bytes",
            MAX_BRIDGE_MSG
        ));
    }
    let parsed: BridgeMsg =
        serde_json::from_str(&msg).map_err(|e| format!("lb_bridge: bad message: {e}"))?;
    if !ALLOWED_TYPES.contains(&parsed.t.as_str()) {
        hub.note(format!("rejected message type '{}'", parsed.t));
        return Err(format!(
            "lb_bridge: message type '{}' is not allowed",
            parsed.t
        ));
    }
    let current_url = webview
        .url()
        .map_err(|e| format!("lb_bridge: could not read caller URL: {e}"))?;
    let primary_only = matches!(parsed.t.as_str(), "assistant_message" | "rpc_result");
    if !hub.origin_allowed(&current_url, primary_only) {
        hub.note(format!(
            "rejected {} from disallowed origin {}",
            parsed.t,
            safe_url_origin(current_url.as_str())
        ));
        return Err(format!(
            "lb_bridge: message '{}' rejected from disallowed origin",
            parsed.t
        ));
    }
    let expected_nonce = hub.current_nonce();
    if !nonce_matches(&expected_nonce, parsed.nonce.as_deref()) {
        hub.note(format!(
            "rejected {} with missing/stale mount nonce",
            parsed.t
        ));
        return Err(format!(
            "lb_bridge: message '{}' rejected (bad or missing nonce)",
            parsed.t
        ));
    }
    match parsed.t.as_str() {
        "hello" => {
            hub.note(format!(
                "hello from {}",
                safe_url_origin(parsed.url.as_deref().unwrap_or_default())
            ));
            Ok(Value::Null)
        }
        // A2: the page may never read or write files — no file_op here.
        "ready" => {
            hub.note("page ready".into());
            crate::webprov::on_page_ready(&webview.app_handle().clone());
            Ok(Value::Null)
        }
        "login_state" => {
            let st = parsed.state.clone().unwrap_or_else(|| "unknown".into());
            let url = parsed.url.clone().unwrap_or_default();
            let reason = parsed.reason.clone().unwrap_or_default();
            hub.note(format!(
                "login_state {st} url={} reason={reason}",
                safe_url_origin(&url)
            ));
            crate::webprov::on_login_state(
                &webview,
                &webview.app_handle().clone(),
                st,
                safe_url_origin(&url),
                reason,
            );
            Ok(Value::Null)
        }
        "assistant_message" => {
            let text = parsed.text.clone().unwrap_or_default();
            let seq = parsed.seq.unwrap_or(0);
            // B2: a foreign page (navigation inside the provider webview) does
            // not know the per-mount nonce; reject its pushes so it cannot
            // inject fake assistant replies into a running task.
            let nonce = parsed.nonce.clone().unwrap_or_default();
            if nonce.is_empty() || nonce != hub.current_nonce() {
                hub.note(format!(
                    "rejected assistant_message seq={seq} (bad/missing nonce)"
                ));
                return Err("lb_bridge: assistant_message rejected (bad or missing nonce)".into());
            }
            hub.note(format!("assistant_message seq={seq} len={}", text.len()));
            crate::webprov::on_assistant_message(&webview, text, seq);
            Ok(Value::Null)
        }
        "rpc_result" => {
            let id = parsed
                .id
                .clone()
                .ok_or("lb_bridge: rpc_result missing id")?;
            let nonce = parsed.nonce.clone().unwrap_or_default();
            let raw = parsed.v.as_deref().unwrap_or("null");
            let value: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
            if !hub.resolve(&id, &nonce, value) {
                return Err("lb_bridge: rpc rejected (unknown id or bad nonce)".into());
            }
            Ok(Value::Null)
        }
        // ALLOWED_TYPES check above makes this arm unreachable; keep for safety.
        other => Err(format!("lb_bridge: unknown message type '{other}'")),
    }
}

fn safe_url_origin(value: &str) -> String {
    let Ok(url) = tauri::Url::parse(value) else {
        return "[invalid URL]".into();
    };
    match (url.scheme(), url.host_str()) {
        ("http" | "https", Some(host)) => {
            let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
            format!("{}://{}{}", url.scheme(), host, port)
        }
        _ => "[non-web URL]".into(),
    }
}

fn nonce_matches(expected: &str, provided: Option<&str>) -> bool {
    !expected.is_empty() && provided == Some(expected)
}

/// Startup self-check: a static assertion that every `State<T>` requested by an
/// app command is actually `.manage()`d in lib.rs. If a command needs an
/// unmanaged type, Tauri silently rejects ALL calls; this table makes that a
/// test failure instead of a silent runtime outage.
pub fn managed_types_expected() -> &'static [&'static str] {
    &[
        "settings::SettingsStore",
        "ui::WorkspaceSlot",
        "Arc<bridge::BridgeHub>",
        "Arc<webprov::WebviewState>",
        "Arc<history::HistoryStore>",
        "Arc<providers::RelaySlot>",
        "agent::ActiveAgent",
        "terminal::TermState",
        "adapters::AdaptersState",
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run_checks;

    #[test]
    fn bridge_origin_is_limited_to_mount_hosts() {
        let hub = BridgeHub::default();
        hub.set_origin(
            "https://chatgpt.com",
            "chatgpt.com",
            &["accounts.google.com".into()],
        );
        assert!(hub.origin_allowed(&tauri::Url::parse("https://chatgpt.com/c/1").unwrap(), true));
        assert!(hub.origin_allowed(
            &tauri::Url::parse("https://accounts.google.com/login").unwrap(),
            false
        ));
        assert!(!hub.origin_allowed(
            &tauri::Url::parse("https://accounts.google.com/login").unwrap(),
            true
        ));
        assert!(!hub.origin_allowed(&tauri::Url::parse("https://evil.example/").unwrap(), false));
        hub.clear_origin();
        assert!(!hub.origin_allowed(&tauri::Url::parse("https://chatgpt.com/").unwrap(), false));
    }

    #[test]
    fn every_bridge_message_requires_the_current_mount_nonce() {
        assert!(nonce_matches("mount-1", Some("mount-1")));
        assert!(!nonce_matches("mount-1", Some("mount-2")));
        assert!(!nonce_matches("mount-1", None));
        assert!(!nonce_matches("", Some("")));
    }

    /// A1: the bridge command's State type must match what lib.rs manages.
    /// Tauri rejects every call when a command's `State<T>` is not managed, so
    /// every RPC from the page would time out. This is the regression test that
    /// previously hung in production.
    #[test]
    fn bridge_hub_is_managed_as_arc() {
        // lib.rs must manage Arc<BridgeHub>; the command signature must match.
        assert!(run_checks().contains("Arc<bridge::BridgeHub>"));
        // And the hub exposes nonce + events API that webprov uses.
        let hub = BridgeHub::default();
        let n1 = hub.current_nonce();
        assert!(n1.is_empty(), "no nonce until first mount");
        hub.new_nonce();
        let n2 = hub.current_nonce();
        assert_ne!(n1, n2, "nonce rotated on mount");
        assert_eq!(n2.len(), 33, "n + 32 hex chars");
        // resolve with wrong nonce must NOT resolve
        let (_, nonce, _rx) = hub.begin();
        assert!(
            !hub.resolve("r1", "forged", Value::Null),
            "foreign page without nonce cannot resolve"
        );
        assert!(
            hub.resolve("r1", &nonce, Value::Null),
            "correct nonce resolves"
        );
        // Allowed types list contains exactly the page-safe set.
        assert_eq!(
            ALLOWED_TYPES,
            &[
                "hello",
                "ready",
                "login_state",
                "assistant_message",
                "rpc_result"
            ]
        );
        // Events ring is bounded.
        for i in 0..300 {
            hub.note(format!("line {i}"));
        }
        assert!(hub.events().len() <= 200);
        assert_eq!(
            safe_url_origin("https://user:pass@example.com/path?token=secret#fragment"),
            "https://example.com"
        );
        let sanitized =
            safe_url_origin("https://example.com/path?token=secret#access_token=secret");
        assert!(!sanitized.contains("secret"));
        assert_eq!(sanitized, "https://example.com");
        assert_eq!(safe_url_origin("file:///C:/secret"), "[non-web URL]");
        assert_eq!(safe_url_origin("not a URL"), "[invalid URL]");
    }
}
