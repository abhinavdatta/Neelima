//! All UI-facing commands. EVERY command label-checks its caller: only the
//! "ui" webview may invoke these. (The provider webview's capability grants
//! exactly one command — lb_bridge — and the app ACL manifest denies it
//! everything else anyway. This guard is the second wall.)

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State, Webview};

use crate::adapters::{Adapter, AdaptersState};
use crate::agent::{ActiveAgent, AgentCommand, AgentInput, AgentShared, CallDecision};
use crate::bridge::BridgeHub;
use crate::history::{HistoryStore, TranscriptEntry};
use crate::providers::{list_models, LocalKind, LocalProvider, ManualProvider, Provider};
use crate::settings::{Settings, SettingsStore};
use crate::terminal::TermState;
use crate::webprov::{self, InspectorSession, WebviewState};
use crate::workspace::Workspace;

fn guard(webview: &Webview) -> Result<(), String> {
    if webview.label() == "ui" {
        Ok(())
    } else {
        Err(format!("command not allowed from webview '{}'", webview.label()))
    }
}

fn ws_from(state: &WorkspaceSlot) -> Result<Workspace, String> {
    state.0.lock().unwrap().clone().ok_or_else(|| "no workspace open — pick a folder first".into())
}

#[derive(Default)]
pub struct WorkspaceSlot(pub std::sync::Mutex<Option<Workspace>>);

#[tauri::command]
pub fn ui_pick_workspace(app: AppHandle, webview: Webview) -> Result<Option<String>, String> {
    guard(&webview)?;
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path.map(|p| p.to_string()));
    });
    match rx.recv_timeout(std::time::Duration::from_secs(120)) {
        Ok(Some(p)) => Ok(Some(p)),
        Ok(None) => Ok(None),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub fn ui_workspace_add(webview: Webview, slot: State<'_, WorkspaceSlot>, settings: State<'_, SettingsStore>, path: String) -> Result<Value, String> {
    guard(&webview)?;
    let ws = Workspace::open(std::path::Path::new(&path)).map_err(|e| e.to_string())?;
    let id = format!("{}", uuid::Uuid::new_v4().simple());
    let name = ws.display_name();
    let display = ws.root().to_string_lossy().into_owned();
    *slot.0.lock().unwrap() = Some(ws);
    settings.patch(|s| {
        if !s.workspaces.iter().any(|w| w.path == display) {
            s.workspaces.push(crate::settings::WorkspaceEntry { id: id.clone(), name: name.clone(), path: display.clone() });
        }
        s.active_workspace_id = Some(id);
    })?;
    Ok(json!({"name": name, "path": display}))
}

#[tauri::command]
pub fn ui_workspace_list(webview: Webview, settings: State<'_, SettingsStore>) -> Result<Value, String> {
    guard(&webview)?;
    let s = settings.get();
    Ok(json!({"workspaces": s.workspaces, "active": s.active_workspace_id}))
}

#[tauri::command]
pub fn ui_workspace_use(webview: Webview, slot: State<'_, WorkspaceSlot>, settings: State<'_, SettingsStore>, id: String) -> Result<(), String> {
    guard(&webview)?;
    let s = settings.get();
    let entry = s.workspaces.iter().find(|w| w.id == id).ok_or("workspace not found")?;
    let ws = Workspace::open(std::path::Path::new(&entry.path)).map_err(|e| e.to_string())?;
    *slot.0.lock().unwrap() = Some(ws);
    settings.patch(|st| st.active_workspace_id = Some(id))?;
    Ok(())
}

#[tauri::command]
pub fn ui_tree(webview: Webview, slot: State<'_, WorkspaceSlot>, path: String) -> Result<Value, String> {
    guard(&webview)?;
    let ws = ws_from(&slot)?;
    let dir = if path.is_empty() { ws.root().to_path_buf() } else { ws.resolve(&path).map_err(|e| e.to_string())? };
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') { continue; }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        entries.push(json!({"name": name, "dir": is_dir, "path": format!("{}/{}", path.trim_end_matches('/'), name)}));
        if entries.len() >= 400 { break; }
    }
    entries.sort_by(|a, b| b["dir"].as_bool().cmp(&a["dir"].as_bool()).then(a["name"].as_str().cmp(&b["name"].as_str())));
    Ok(json!({ "path": path, "entries": entries }))
}

#[tauri::command]
pub fn ui_settings_get(webview: Webview, settings: State<'_, SettingsStore>) -> Result<Settings, String> {
    guard(&webview)?;
    Ok(settings.get())
}

#[tauri::command]
pub fn ui_settings_set(webview: Webview, app: AppHandle, settings: State<'_, SettingsStore>, next: Settings) -> Result<Settings, String> {
    guard(&webview)?;
    let saved = settings.set(next)?;
    crate::register_hotkey(&app, &saved.hotkey)?;
    Ok(saved)
}

#[tauri::command]
pub fn ui_adapters_list(webview: Webview, adapters: State<'_, AdaptersState>) -> Result<Vec<Adapter>, String> {
    guard(&webview)?;
    Ok(adapters.list.lock().unwrap().clone())
}

#[tauri::command]
pub fn ui_adapters_open_folder(app: AppHandle, webview: Webview) -> Result<(), String> {
    guard(&webview)?;
    let dir = crate::adapters::adapters_dir(&app.path().app_config_dir().map_err(|e| e.to_string())?);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    { let _ = std::process::Command::new("explorer").arg(&dir).spawn(); }
    #[cfg(target_os = "macos")]
    { let _ = std::process::Command::new("open").arg(&dir).spawn(); }
    #[cfg(all(unix, not(target_os = "macos")))]
    { let _ = std::process::Command::new("xdg-open").arg(&dir).spawn(); }
    Ok(())
}

#[tauri::command]
pub async fn ui_adapter_start_inspector(webview: Webview, app: AppHandle, state: State<'_, Arc<WebviewState>>, name: String, url: String) -> Result<(), String> {
    guard(&webview)?;
    let adapter = Adapter { id: "inspector-draft".into(), name: name.clone(), url: url.clone(), ..Adapter::default() };
    *state.inspector.lock().unwrap() = Some(InspectorSession { req_id: String::new(), kind: String::new(), selectors: Vec::new(), name, url });
    let profile = "inspector";
    webprov::mount(&app, profile, &adapter, &state).await
}

#[tauri::command]
pub async fn ui_adapter_capture(webview: Webview, hub: State<'_, Arc<BridgeHub>>, state: State<'_, Arc<WebviewState>>, kind: String) -> Result<Value, String> {
    guard(&webview)?;
    let app = webview.app_handle().clone();
    let wv = app.get_webview(webprov::PROVIDER_LABEL).ok_or("inspector webview not open")?;
    let (req_id, rx) = hub.begin();
    {
        let mut ins = state.inspector.lock().unwrap();
        if let Some(i) = ins.as_mut() {
            i.req_id = req_id.clone();
            i.kind = kind.clone();
        }
    }
    let js = format!("window.__LB__ && window.__LB__.call('inspector_start', {:?}, {:?})", kind, req_id);
    wv.eval(js).map_err(|e| e.to_string())?;
    let v = crate::bridge::BridgeHub::wait(rx, 120_000).await?;
    let selector = v["value"]["selector"].as_str().unwrap_or("").to_string();
    if let Some(i) = state.inspector.lock().unwrap().as_mut() {
        i.selectors.push((kind.clone(), selector.clone()));
    }
    Ok(json!({"kind": kind, "selector": selector}))
}

#[tauri::command]
pub fn ui_adapter_finish_inspector(webview: Webview, app: AppHandle, state: State<'_, Arc<WebviewState>>, adapters: State<'_, AdaptersState>) -> Result<Adapter, String> {
    guard(&webview)?;
    let ins = state.inspector.lock().unwrap().take().ok_or("no inspector session")?;
    let selector = |kind: &str| -> String {
        ins.selectors.iter().find(|(k, _)| k == kind).map(|(_, v)| v.clone()).unwrap_or_default()
    };
    let adapter = Adapter {
        id: format!("user-{}", uuid::Uuid::new_v4().simple()),
        name: ins.name,
        url: ins.url,
        selectors: crate::adapters::Selectors {
            input: selector("input"),
            send_button: selector("send"),
            stop_button: None,
            messages: selector("assistant").rsplit(' ').next().unwrap_or("main").to_string(),
            new_chat: None,
            logged_in: None,
        },
        input: crate::adapters::InputSpec::default(),
        quiet_ms: 2000,
        response_timeout_ms: 300_000,
        built_in: false,
    };
    let dir = crate::adapters::adapters_dir(&app.path().app_config_dir().map_err(|e| e.to_string())?);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", adapter.id));
    std::fs::write(&path, serde_json::to_vec_pretty(&adapter).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    // Hot reload happens via the watcher; also refresh immediately.
    if let Ok(list) = crate::adapters::load_all(&dir) {
        *adapters.list.lock().unwrap() = list;
    }
    webprov::unmount_if_any(&app, &state);
    Ok(adapter)
}

#[tauri::command]
pub async fn ui_providers_login(webview: Webview, app: AppHandle, state: State<'_, Arc<WebviewState>>, adapters: State<'_, AdaptersState>, settings: State<'_, SettingsStore>, profile_id: String) -> Result<(), String> {
    guard(&webview)?;
    let profiles = settings.get().providers.web;
    let profile = profiles.iter().find(|p| p.id == profile_id).ok_or("profile not found")?;
    let adapter = adapters.list.lock().unwrap().iter().find(|a| a.id == profile.adapter_id).cloned().ok_or("adapter missing for profile")?;
    webprov::mount(&app, &profile_id, &adapter, &state).await
}

#[tauri::command]
pub fn ui_providers_close(webview: Webview, app: AppHandle, state: State<'_, Arc<WebviewState>>) -> Result<(), String> {
    guard(&webview)?;
    webprov::unmount_if_any(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn ui_providers_list(webview: Webview, settings: State<'_, SettingsStore>, adapters: State<'_, AdaptersState>) -> Result<Value, String> {
    guard(&webview)?;
    let s = settings.get();
    let list = adapters.list.lock().unwrap().clone();
    Ok(json!({
        "web": s.providers.web,
        "ollama": s.providers.ollama,
        "lmstudio": s.providers.lmstudio,
        "adapters": list,
    }))
}

#[tauri::command]
pub async fn ui_models_local(webview: Webview, settings: State<'_, SettingsStore>, kind: String) -> Result<Vec<String>, String> {
    guard(&webview)?;
    let s = settings.get();
    match kind.as_str() {
        "ollama" => {
            let url = s.providers.ollama.as_ref().map(|o| o.url.clone()).unwrap_or_else(|| "http://localhost:11434".into());
            list_models(LocalKind::Ollama, &url).await
        }
        "lmstudio" => {
            let url = s.providers.lmstudio.as_ref().map(|o| o.url.clone()).unwrap_or_else(|| "http://localhost:1234".into());
            list_models(LocalKind::LmStudio, &url).await
        }
        _ => Err("unknown local provider".into()),
    }
}

#[tauri::command]
pub fn ui_task_start(
    webview: Webview,
    app: AppHandle,
    slot: State<'_, WorkspaceSlot>,
    settings: State<'_, SettingsStore>,
    adapters: State<'_, AdaptersState>,
    history: State<'_, Arc<HistoryStore>>,
    webview_state: State<'_, Arc<WebviewState>>,
    hub: State<'_, Arc<BridgeHub>>,
    relay: State<'_, Arc<crate::providers::RelaySlot>>,
    active: State<'_, ActiveAgent>,
    prompt: String,
    provider_id: String,
) -> Result<String, String> {
    guard(&webview)?;
    if active.get().is_some() {
        return Err("a task is already running — stop it first".into());
    }
    let ws = ws_from(&slot)?;
    let settings_snapshot = settings.get();
    let provider = build_provider(&app, &settings_snapshot, &adapters, webview_state.inner(), hub.inner(), relay.inner(), &provider_id)?;

    let task_id = format!("t{}", uuid::Uuid::new_v4().simple());
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel();
    let shared = Arc::new(AgentShared {
        cmd_tx,
        cmd_rx: std::sync::Mutex::new(Some(cmd_rx)),
        state: std::sync::Mutex::new(crate::agent::AgentState::Idle),
        task_id: std::sync::Mutex::new(Some(task_id.clone())),
    });
    *active.0.lock().unwrap() = Some(shared.clone());

    let input = AgentInput {
        app: app.clone(),
        task_id,
        prompt,
        provider,
        ws,
        settings: settings_snapshot,
        history: history.inner().clone(),
        webview_state: webview_state.inner().clone(),
        relay: relay.inner().clone(),
        shared,
        prior_entries: Vec::new(),
    };
    tauri::async_runtime::spawn(crate::agent::run(input));
    Ok("started".into())
}

fn build_provider(
    app: &AppHandle,
    settings: &Settings,
    adapters: &State<'_, AdaptersState>,
    webview_state: &Arc<WebviewState>,
    hub: &Arc<BridgeHub>,
    relay: &Arc<crate::providers::RelaySlot>,
    provider_id: &str,
) -> Result<Provider, String> {
    if let Some(profile_id) = provider_id.strip_prefix("web:") {
        let profile = settings.providers.web.iter().find(|p| p.id == profile_id).ok_or("profile not found")?;
        let adapter = adapters.list.lock().unwrap().iter().find(|a| a.id == profile.adapter_id).cloned().ok_or("adapter missing")?;
        return Ok(Provider::Web(crate::webprov::WebProvider {
            app: app.clone(),
            profile_id: profile_id.to_string(),
            adapter,
            hub: hub.clone(),
            state: webview_state.clone(),
        }));
    }
    match provider_id {
        "ollama" => {
            let cfg = settings.providers.ollama.clone().ok_or("Ollama not configured — open Settings")?;
            Ok(Provider::Local(LocalProvider::new(app.clone(), LocalKind::Ollama, cfg)))
        }
        "lmstudio" => {
            let cfg = settings.providers.lmstudio.clone().ok_or("LM Studio not configured — open Settings")?;
            Ok(Provider::Local(LocalProvider::new(app.clone(), LocalKind::LmStudio, cfg)))
        }
        "manual" => Ok(Provider::Manual(ManualProvider::new(app.clone(), relay.clone()))),
        other => Err(format!("unknown provider '{other}'")),
    }
}

#[tauri::command]
pub fn ui_task_stop(webview: Webview, active: State<'_, ActiveAgent>, term: State<'_, TermState>) -> Result<(), String> {
    guard(&webview)?;
    if let Some(shared) = active.get() {
        let _ = shared.cmd_tx.send(AgentCommand::Stop);
    }
    term.kill_all();
    Ok(())
}

#[tauri::command]
pub fn ui_task_continue(
    webview: Webview,
    app: AppHandle,
    slot: State<'_, WorkspaceSlot>,
    settings: State<'_, SettingsStore>,
    adapters: State<'_, AdaptersState>,
    history: State<'_, Arc<HistoryStore>>,
    webview_state: State<'_, Arc<WebviewState>>,
    hub: State<'_, Arc<BridgeHub>>,
    relay: State<'_, Arc<crate::providers::RelaySlot>>,
    active: State<'_, ActiveAgent>,
    task_id: String,
    provider_id: String,
) -> Result<String, String> {
    guard(&webview)?;
    if active.get().is_some() {
        return Err("a task is already running — stop it first".into());
    }
    let prior = history.read_transcript(&task_id, 100)?;
    let last_prompt = prior.iter().rev().find(|e| e.kind == "user_prompt").map(|e| e.text.clone()).ok_or("task has no prompt to continue")?;
    let ws = ws_from(&slot)?;
    let settings_snapshot = settings.get();
    let provider = build_provider(&app, &settings_snapshot, &adapters, webview_state.inner(), hub.inner(), relay.inner(), &provider_id)?;
    let new_task_id = format!("t{}", uuid::Uuid::new_v4().simple());
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel();
    let shared = Arc::new(AgentShared {
        cmd_tx,
        cmd_rx: std::sync::Mutex::new(Some(cmd_rx)),
        state: std::sync::Mutex::new(crate::agent::AgentState::Idle),
        task_id: std::sync::Mutex::new(Some(new_task_id.clone())),
    });
    *active.0.lock().unwrap() = Some(shared.clone());
    let input = AgentInput {
        app: app.clone(),
        task_id: new_task_id,
        prompt: format!("Continue the previous task: {last_prompt}"),
        provider,
        ws,
        settings: settings_snapshot,
        history: history.inner().clone(),
        webview_state: webview_state.inner().clone(),
        relay: relay.inner().clone(),
        shared,
        prior_entries: prior,
    };
    tauri::async_runtime::spawn(crate::agent::run(input));
    Ok("started".into())
}

#[tauri::command]
pub fn ui_approve(webview: Webview, active: State<'_, ActiveAgent>, decisions: Vec<CallDecision>) -> Result<(), String> {
    guard(&webview)?;
    let shared = active.get().ok_or("no running task")?;
    let _ = shared.cmd_tx.send(AgentCommand::Approve(decisions));
    Ok(())
}

#[tauri::command]
pub fn ui_relay_reply(webview: Webview, relay: State<'_, Arc<crate::providers::RelaySlot>>, text: String) -> Result<(), String> {
    guard(&webview)?;
    if !relay.deliver(text) {
        return Err("no manual relay is waiting for a reply right now".into());
    }
    Ok(())
}

#[tauri::command]
pub fn ui_webview_mode(webview: Webview, app: AppHandle, state: State<'_, Arc<WebviewState>>, mode: String) -> Result<(), String> {
    guard(&webview)?;
    match mode.as_str() {
        "provider" => webprov::set_visible(&app, &state, true),
        "chat" => {
            // Hidden webviews are DESTROYED (spec): data dir persists.
            webprov::unmount_if_any(&app, &state);
        }
        other => return Err(format!("unknown mode {other}")),
    }
    Ok(())
}

#[tauri::command]
pub fn ui_webview_rect(webview: Webview, app: AppHandle, state: State<'_, Arc<WebviewState>>, x: i32, y: i32, w: i32, h: i32) -> Result<(), String> {
    guard(&webview)?;
    webprov::apply_rect(&app, &state, webprov::Rect { x, y, w, h });
    Ok(())
}

#[tauri::command]
pub fn ui_terminal_create(webview: Webview, app: AppHandle, settings: State<'_, SettingsStore>, slot: State<'_, WorkspaceSlot>) -> Result<u32, String> {
    guard(&webview)?;
    let cwd = slot.0.lock().unwrap().clone().map(|w| w.root().to_path_buf());
    crate::terminal::create(app, settings.get().shell, cwd)
}

#[tauri::command]
pub fn ui_terminal_write(webview: Webview, term: State<'_, TermState>, id: u32, data: String) -> Result<(), String> {
    guard(&webview)?;
    crate::terminal::write(&term, id, &data)
}

#[tauri::command]
pub fn ui_terminal_resize(webview: Webview, term: State<'_, TermState>, id: u32, rows: u16, cols: u16) -> Result<(), String> {
    guard(&webview)?;
    crate::terminal::resize(&term, id, rows, cols)
}

#[tauri::command]
pub fn ui_terminal_kill(webview: Webview, term: State<'_, TermState>, id: u32) -> Result<(), String> {
    guard(&webview)?;
    crate::terminal::kill(&term, id)
}

#[tauri::command]
pub fn ui_checkpoint_list(webview: Webview, slot: State<'_, WorkspaceSlot>) -> Result<Vec<crate::checkpoints::Checkpoint>, String> {
    guard(&webview)?;
    let ws = ws_from(&slot)?;
    crate::checkpoints::list(&ws)
}

#[tauri::command]
pub fn ui_checkpoint_create(webview: Webview, slot: State<'_, WorkspaceSlot>, label: String) -> Result<crate::checkpoints::Checkpoint, String> {
    guard(&webview)?;
    let ws = ws_from(&slot)?;
    crate::checkpoints::snapshot(&ws, &label)
}

#[tauri::command]
pub fn ui_checkpoint_restore(webview: Webview, slot: State<'_, WorkspaceSlot>, id: String) -> Result<Value, String> {
    guard(&webview)?;
    let ws = ws_from(&slot)?;
    let files = crate::checkpoints::restore(&ws, &id)?;
    Ok(json!({"restored_files": files, "checkpoint": id}))
}

#[tauri::command]
pub fn ui_history_tasks(webview: Webview, history: State<'_, Arc<HistoryStore>>) -> Result<Value, String> {
    guard(&webview)?;
    Ok(json!(history.list_tasks(100)))
}

#[tauri::command]
pub fn ui_history_open(webview: Webview, history: State<'_, Arc<HistoryStore>>, task_id: String) -> Result<Vec<TranscriptEntry>, String> {
    guard(&webview)?;
    history.read_transcript(&task_id, 400)
}

#[tauri::command]
pub fn ui_search_tasks(webview: Webview, history: State<'_, Arc<HistoryStore>>, q: String) -> Result<Value, String> {
    guard(&webview)?;
    let ql = q.to_lowercase();
    let matches: Vec<_> = history
        .list_tasks(500)
        .into_iter()
        .filter(|m| m.title.to_lowercase().contains(&ql) || m.workspace.to_lowercase().contains(&ql))
        .collect();
    Ok(json!(matches))
}

#[tauri::command]
pub fn ui_diff_get(webview: Webview, history: State<'_, Arc<HistoryStore>>, task_id: String, entry_id: u64) -> Result<Value, String> {
    guard(&webview)?;
    let entries = history.read_transcript(&task_id, 1000)?;
    let entry = entries.iter().find(|e| e.id == entry_id).ok_or("entry not found")?;
    if let Some(d) = &entry.diff {
        return Ok(json!({"path": d.path, "old": d.old, "new": d.new}));
    }
    Err("entry has no diff".into())
}

#[tauri::command]
pub fn ui_app_info(webview: Webview, settings: State<'_, SettingsStore>) -> Result<Value, String> {
    guard(&webview)?;
    Ok(json!({
        "name": "Neelima",
        "version": env!("CARGO_PKG_VERSION"),
        "tauri": tauri::VERSION,
        "settings_path": settings.path().to_string_lossy(),
        "os": std::env::consts::OS,
    }))
}
