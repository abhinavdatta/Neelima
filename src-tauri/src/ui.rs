//! All UI-facing commands. EVERY command label-checks its caller: only the
//! "ui" webview may invoke these. (The provider webview's capability grants
//! exactly one command — lb_bridge — and the app ACL manifest denies it
//! everything else anyway. This guard is the second wall.)

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State, Webview};

use crate::adapters::{Adapter, AdaptersState};
use crate::agent::{ActiveAgent, AgentCommand, AgentInput, AgentShared, CallDecision};
use crate::bridge::BridgeHub;
use crate::history::{HistoryStore, TaskMeta, TranscriptEntry};
use crate::providers::{list_models, LocalKind, LocalProvider, ManualProvider, Provider};
use crate::settings::{Settings, SettingsStore};
use crate::terminal::TermState;
use crate::webprov::{self, InspectorSession, WebviewState};
use crate::workspace::Workspace;

fn guard(webview: &Webview) -> Result<(), String> {
    if webview.label() == "ui" {
        Ok(())
    } else {
        Err(format!(
            "command not allowed from webview '{}'",
            webview.label()
        ))
    }
}

fn ws_from(state: &WorkspaceSlot) -> Result<Workspace, String> {
    state
        .0
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no workspace open — pick a folder first".into())
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
pub fn ui_workspace_add(
    webview: Webview,
    active: State<'_, ActiveAgent>,
    slot: State<'_, WorkspaceSlot>,
    settings: State<'_, SettingsStore>,
    path: String,
) -> Result<Value, String> {
    guard(&webview)?;
    let ws = Workspace::open(std::path::Path::new(&path)).map_err(|e| e.to_string())?;
    let name = ws.display_name();
    let display = ws.root().to_string_lossy().into_owned();
    let active_guard = active.0.lock().unwrap();
    if active_guard.is_some() {
        return Err("workspace cannot be changed while a task is active".into());
    }
    let mut slot_guard = slot.0.lock().unwrap();
    let id = settings
        .get()
        .workspaces
        .into_iter()
        .find(|workspace| workspace.path == display)
        .map(|workspace| workspace.id)
        .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
    settings.patch(|s| {
        if !s.workspaces.iter().any(|w| w.path == display) {
            s.workspaces.push(crate::settings::WorkspaceEntry {
                id: id.clone(),
                name: name.clone(),
                path: display.clone(),
            });
        }
        s.active_workspace_id = Some(id.clone());
    })?;
    *slot_guard = Some(ws);
    Ok(json!({"name": name, "path": display}))
}

#[tauri::command]
pub fn ui_workspace_list(
    webview: Webview,
    settings: State<'_, SettingsStore>,
) -> Result<Value, String> {
    guard(&webview)?;
    let s = settings.get();
    Ok(json!({"workspaces": s.workspaces, "active": s.active_workspace_id}))
}

#[tauri::command]
pub fn ui_workspace_use(
    webview: Webview,
    active: State<'_, ActiveAgent>,
    slot: State<'_, WorkspaceSlot>,
    settings: State<'_, SettingsStore>,
    id: String,
) -> Result<(), String> {
    guard(&webview)?;
    let active_guard = active.0.lock().unwrap();
    if active_guard.is_some() {
        return Err("workspace cannot be changed while a task is active".into());
    }
    let mut slot_guard = slot.0.lock().unwrap();
    let s = settings.get();
    let entry = s
        .workspaces
        .iter()
        .find(|w| w.id == id)
        .ok_or("workspace not found")?;
    let ws = Workspace::open(std::path::Path::new(&entry.path)).map_err(|e| e.to_string())?;
    settings.patch(|st| st.active_workspace_id = Some(id))?;
    *slot_guard = Some(ws);
    Ok(())
}

#[tauri::command]
pub fn ui_workspace_remove(
    webview: Webview,
    active: State<'_, ActiveAgent>,
    slot: State<'_, WorkspaceSlot>,
    settings: State<'_, SettingsStore>,
    id: String,
) -> Result<Value, String> {
    guard(&webview)?;
    let active_guard = active.0.lock().unwrap();
    if active_guard.is_some() {
        return Err("workspace cannot be changed while a task is active".into());
    }
    let mut slot_guard = slot.0.lock().unwrap();
    let s = settings.get();
    let entry = s
        .workspaces
        .iter()
        .find(|w| w.id == id)
        .ok_or("workspace not found")?;
    settings.patch(|st| {
        st.workspaces.retain(|w| w.id != id);
        if st.active_workspace_id.as_deref() == Some(id.as_str()) {
            st.active_workspace_id = None;
        }
    })?;
    // If this workspace is open in the slot, close it first (tools require a
    // workspace, so a stale open slot would keep accepting AI calls).
    // Lock once and compare canonical paths to avoid stale aliases.
    let matches = slot_guard
        .as_ref()
        .map(|ws| ws.root() == std::path::Path::new(&entry.path))
        .unwrap_or(false);
    if matches {
        *slot_guard = None;
    }
    Ok(json!({"removed": id, "path": entry.path}))
}

#[tauri::command]
pub fn ui_workspace_rename(
    webview: Webview,
    settings: State<'_, SettingsStore>,
    id: String,
    name: String,
) -> Result<Value, String> {
    guard(&webview)?;
    let clean = name.trim();
    if clean.is_empty() || clean.len() > 80 || clean.contains('\\') || clean.contains('/') {
        return Err("display name must be 1..=80 chars with no path separators".into());
    }
    settings.patch(|st| {
        if let Some(w) = st.workspaces.iter_mut().find(|w| w.id == id) {
            w.name = clean.to_string();
        }
    })?;
    let saved = settings.get();
    if saved.workspaces.iter().any(|w| w.id == id) {
        Ok(json!({"id": id, "name": clean}))
    } else {
        Err("workspace not found".into())
    }
}

#[tauri::command]
pub fn ui_workspace_open_in_explorer(
    webview: Webview,
    slot: State<'_, WorkspaceSlot>,
    settings: State<'_, SettingsStore>,
    id: Option<String>,
) -> Result<(), String> {
    guard(&webview)?;
    let path = match id {
        Some(id) => settings
            .get()
            .workspaces
            .iter()
            .find(|w| w.id == id)
            .ok_or("workspace not found")?
            .path
            .clone(),
        None => ws_from(&slot)?.root().to_string_lossy().into_owned(),
    };
    #[cfg(windows)]
    {
        crate::procspawn::hidden_std("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        crate::procspawn::hidden_std("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        crate::procspawn::hidden_std("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn ui_tree(
    webview: Webview,
    slot: State<'_, WorkspaceSlot>,
    path: String,
) -> Result<Value, String> {
    guard(&webview)?;
    let ws = ws_from(&slot)?;
    let dir = if path.is_empty() {
        ws.root().to_path_buf()
    } else {
        ws.resolve(&path).map_err(|e| e.to_string())?
    };
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let child = if path.is_empty() || path == "." {
            name.clone()
        } else {
            format!("{}/{}", path.trim_end_matches('/'), name)
        };
        entries.push(json!({"name": name, "dir": is_dir, "path": child}));
        if entries.len() >= 400 {
            break;
        }
    }
    entries.sort_by(|a, b| {
        b["dir"]
            .as_bool()
            .cmp(&a["dir"].as_bool())
            .then(a["name"].as_str().cmp(&b["name"].as_str()))
    });
    Ok(json!({ "path": path, "entries": entries }))
}

#[tauri::command]
pub fn ui_settings_get(
    webview: Webview,
    settings: State<'_, SettingsStore>,
) -> Result<Settings, String> {
    guard(&webview)?;
    Ok(settings.get())
}

#[tauri::command]
pub fn ui_settings_set(
    webview: Webview,
    app: AppHandle,
    settings: State<'_, SettingsStore>,
    next: Settings,
) -> Result<Settings, String> {
    guard(&webview)?;
    let previous = settings.get();
    let saved = settings.set(next)?;
    if let Err(register_error) = crate::register_hotkey(&app, &saved.hotkey) {
        let settings_restore = settings.set(previous.clone()).err();
        let hotkey_restore = crate::register_hotkey(&app, &previous.hotkey).err();
        let mut error = format!("could not register emergency-stop hotkey: {register_error}");
        if let Some(restore_error) = settings_restore {
            error.push_str(&format!(
                "; could not restore previous settings: {restore_error}"
            ));
        }
        if let Some(restore_error) = hotkey_restore {
            error.push_str(&format!(
                "; could not restore previous hotkey: {restore_error}"
            ));
        }
        return Err(error);
    }
    Ok(saved)
}

#[tauri::command]
pub fn ui_adapters_list(
    webview: Webview,
    adapters: State<'_, AdaptersState>,
) -> Result<Vec<Adapter>, String> {
    guard(&webview)?;
    Ok(adapters.list.lock().unwrap().clone())
}

#[tauri::command]
pub fn ui_adapters_open_folder(app: AppHandle, webview: Webview) -> Result<(), String> {
    guard(&webview)?;
    let dir =
        crate::adapters::adapters_dir(&app.path().app_config_dir().map_err(|e| e.to_string())?);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        crate::procspawn::hidden_std("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("could not open Explorer: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        crate::procspawn::hidden_std("open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("could not open Finder: {e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        crate::procspawn::hidden_std("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("could not open file manager: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn ui_adapter_start_inspector(
    webview: Webview,
    app: AppHandle,
    state: State<'_, Arc<WebviewState>>,
    name: String,
    url: String,
) -> Result<(), String> {
    guard(&webview)?;
    let adapter = Adapter {
        id: "inspector-draft".into(),
        name: name.clone(),
        url: url.clone(),
        ..Adapter::default()
    };
    *state.inspector.lock().unwrap() = Some(InspectorSession {
        req_id: String::new(),
        kind: String::new(),
        selectors: Vec::new(),
        name,
        url,
    });
    let profile = "inspector";
    webprov::mount(&app, profile, &adapter, &state).await
}

#[tauri::command]
pub async fn ui_adapter_capture(
    webview: Webview,
    hub: State<'_, Arc<BridgeHub>>,
    state: State<'_, Arc<WebviewState>>,
    kind: String,
) -> Result<Value, String> {
    guard(&webview)?;
    let app = webview.app_handle().clone();
    let wv = app
        .get_webview(webprov::PROVIDER_LABEL)
        .ok_or("inspector webview not open")?;
    let (req_id, _nonce, rx) = hub.begin();
    {
        let mut ins = state.inspector.lock().unwrap();
        if let Some(i) = ins.as_mut() {
            i.req_id = req_id.clone();
            i.kind = kind.clone();
        }
    }
    let js = format!(
        "window.__LB__ && window.__LB__.call('inspector_start', {:?}, {:?})",
        kind, req_id
    );
    wv.eval(js).map_err(|e| e.to_string())?;
    let v = crate::bridge::BridgeHub::wait(rx, 120_000).await?;
    let selector = v["value"]["selector"].as_str().unwrap_or("").to_string();
    if let Some(i) = state.inspector.lock().unwrap().as_mut() {
        i.selectors.push((kind.clone(), selector.clone()));
    }
    Ok(json!({"kind": kind, "selector": selector}))
}

#[tauri::command]
pub fn ui_adapter_finish_inspector(
    webview: Webview,
    app: AppHandle,
    state: State<'_, Arc<WebviewState>>,
    adapters: State<'_, AdaptersState>,
) -> Result<Adapter, String> {
    guard(&webview)?;
    if *state.task_active.lock().unwrap() {
        return Err("cannot replace the provider webview while an agent task is active".into());
    }
    let ins = state
        .inspector
        .lock()
        .unwrap()
        .take()
        .ok_or("no inspector session")?;
    let ins_url = ins.url.clone();
    let selector = |kind: &str| -> String {
        ins.selectors
            .iter()
            .find(|(k, _)| k == kind)
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    };
    let adapter = Adapter {
        id: format!("user-{}", uuid::Uuid::new_v4().simple()),
        name: ins.name,
        url: ins_url.clone(),
        selectors: crate::adapters::Selectors {
            input: selector("input"),
            send_button: selector("send"),
            stop_button: None,
            messages: selector("assistant")
                .rsplit(' ')
                .next()
                .unwrap_or("main")
                .to_string(),
            new_chat: None,
            logged_in: None,
            logged_out: None,
        },
        input: crate::adapters::InputSpec::default(),
        quiet_ms: 2000,
        response_timeout_ms: 300_000,
        built_in: false,
        allowed_domain: crate::webprov::host_of(&ins_url),
        auth_domains: Vec::new(),
        login_url_patterns: Vec::new(),
    };
    let dir =
        crate::adapters::adapters_dir(&app.path().app_config_dir().map_err(|e| e.to_string())?);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", adapter.id));
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&adapter).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    // Hot reload happens via the watcher; also refresh immediately.
    if let Ok(list) = crate::adapters::load_all(&dir) {
        *adapters.list.lock().unwrap() = list;
    }
    webprov::unmount_if_any(&app, &state);
    Ok(adapter)
}

#[tauri::command]
pub async fn ui_providers_login(
    webview: Webview,
    app: AppHandle,
    state: State<'_, Arc<WebviewState>>,
    adapters: State<'_, AdaptersState>,
    settings: State<'_, SettingsStore>,
    profile_id: String,
) -> Result<(), String> {
    guard(&webview)?;
    let profiles = settings.get().providers.web;
    let profile = profiles
        .iter()
        .find(|p| p.id == profile_id)
        .ok_or("profile not found")?;
    let adapter = adapters
        .list
        .lock()
        .unwrap()
        .iter()
        .find(|a| a.id == profile.adapter_id)
        .cloned()
        .ok_or("adapter missing for profile")?;
    webprov::mount(&app, &profile_id, &adapter, &state).await
}

#[tauri::command]
pub fn ui_providers_close(
    webview: Webview,
    app: AppHandle,
    state: State<'_, Arc<WebviewState>>,
) -> Result<(), String> {
    guard(&webview)?;
    if *state.task_active.lock().unwrap() {
        return Err("cannot close the provider webview while an agent task is active".into());
    }
    webprov::unmount_if_any(&app, &state);
    Ok(())
}

/// A11: diagnostics for the "can't reach the page" flow in ProviderPane.
#[tauri::command]
pub async fn ui_provider_diagnose(
    webview: Webview,
    app: AppHandle,
    hub: State<'_, Arc<BridgeHub>>,
    state: State<'_, Arc<WebviewState>>,
    adapters: State<'_, AdaptersState>,
    settings: State<'_, SettingsStore>,
) -> Result<Value, String> {
    guard(&webview)?;
    let mounted = {
        let m = state.mounted.lock().unwrap();
        m.as_ref()
            .map(|p| (p.profile_id.clone(), p.adapter_id.clone()))
    };
    if mounted.is_none() {
        return Ok(json!({"mounted": false}));
    }
    let (profile_id, adapter_id) = mounted.unwrap();
    let adapter = adapters
        .list
        .lock()
        .unwrap()
        .iter()
        .find(|a| a.id == adapter_id)
        .cloned();

    // Ping the page: one bounded RPC through the bridge.
    let started = std::time::Instant::now();
    let (req_id, nonce, rx) = hub.begin();
    let ping = {
        let wv = app.get_webview(webprov::PROVIDER_LABEL);
        match wv {
            Some(wv) => {
                let js = format!(
                    "window.__LB__ && window.__LB__.call('ping', null, {:?}, {:?})",
                    req_id, nonce
                );
                match wv.eval(js) {
                    Ok(()) => match crate::bridge::BridgeHub::wait(rx, 15_000).await {
                        Ok(_) => Some(started.elapsed().as_millis() as u64),
                        Err(e) => {
                            hub.cancel(&req_id);
                            *state.last_bridge_error.lock().unwrap() = Some(format!("ping: {e}"));
                            None
                        }
                    },
                    Err(e) => {
                        hub.cancel(&req_id);
                        *state.last_bridge_error.lock().unwrap() = Some(format!("ping eval: {e}"));
                        None
                    }
                }
            }
            None => {
                hub.cancel(&req_id);
                None
            }
        }
    };

    // Deep info from the page (selectors state).
    let (req_id2, nonce2, rx2) = hub.begin();
    let mut input_found = None;
    let mut send_found = None;
    let mut messages_found = None;
    if let Some(wv) = app.get_webview(webprov::PROVIDER_LABEL) {
        let js = format!(
            "window.__LB__ && window.__LB__.call('page_info', null, {:?}, {:?})",
            req_id2, nonce2
        );
        if let Err(e) = wv.eval(js) {
            hub.cancel(&req_id2);
            *state.last_bridge_error.lock().unwrap() = Some(format!("page_info eval: {e}"));
        } else {
            match crate::bridge::BridgeHub::wait(rx2, 10_000).await {
                Ok(v) => {
                    input_found = v["value"]["input_found"].as_bool();
                    send_found = v["value"]["send_button_found"].as_bool();
                    messages_found = v["value"]["messages_found"].as_bool();
                }
                Err(e) => {
                    hub.cancel(&req_id2);
                    *state.last_bridge_error.lock().unwrap() = Some(format!("page_info: {e}"));
                }
            }
        }
    } else {
        hub.cancel(&req_id2);
    }
    let (login, url, reason): (String, String, String) = match &*state.login.lock().unwrap() {
        crate::webprov::LoginState::LoggedIn { url } => {
            ("logged_in".into(), url.clone(), String::new())
        }
        crate::webprov::LoginState::LoggedOut { url } => {
            ("logged_out".into(), url.clone(), String::new())
        }
        crate::webprov::LoginState::Unknown { reason, url } => {
            ("unknown".into(), url.clone(), reason.clone())
        }
    };
    Ok(json!({
        "mounted": true,
        "profile": profile_id,
        "adapter": adapter_id,
        "adapter_name": adapter.as_ref().map(|a| a.name.clone()).unwrap_or_default(),
        "url": url,
        "auth_domains": adapter.as_ref().map(|a| a.auth_domains.clone()).unwrap_or_default(),
        "login_url_patterns": adapter.as_ref().map(|a| a.login_url_patterns.clone()).unwrap_or_default(),
        "ping_ms": ping,
        "login_state": login,
        "reason": reason,
        "input_found": input_found,
        "send_button_found": send_found,
        "messages_found": messages_found,
        "manual_fallback": *state.manual_fallback.lock().unwrap(),
        "last_bridge_error": *state.last_bridge_error.lock().unwrap(),
        "bridge_log_path": hub.log_path().map(|p| p.display().to_string()),
        "bridge_log_write_error": hub.log_write_error(),
        "bridge_log": hub.events().iter().rev().take(30).rev().cloned().collect::<Vec<_>>(),
        "settings_sample": {
            "adapter_domains": adapter.as_ref().map(|a| a.allowed_domain.clone()).unwrap_or_default(),
            "profile": settings.get().providers.web.iter().find(|p| p.id == profile_id).map(|p| p.name.clone()).unwrap_or_default(),
        },
    }))
}

/// A4: the "I'm logged in, continue" override — flips the push-derived login
/// posture so a stuck task/onboarding can proceed without a remount.
#[tauri::command]
pub fn ui_provider_login_override(
    webview: Webview,
    state: State<'_, Arc<WebviewState>>,
    app: AppHandle,
) -> Result<(), String> {
    guard(&webview)?;
    let url = match &*state.login.lock().unwrap() {
        crate::webprov::LoginState::Unknown { url, .. } => url.clone(),
        crate::webprov::LoginState::LoggedOut { url } => url.clone(),
        crate::webprov::LoginState::LoggedIn { url } => url.clone(),
    };
    *state.login.lock().unwrap() = crate::webprov::LoginState::LoggedIn { url };
    state.login_changed.notify_waiters();
    let _ = app.emit("evt", serde_json::json!({"kind": "provider-login-state", "state": "logged_in", "reason": "manual override"}));
    Ok(())
}

#[tauri::command]
pub fn ui_providers_list(
    webview: Webview,
    settings: State<'_, SettingsStore>,
    adapters: State<'_, AdaptersState>,
) -> Result<Value, String> {
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
pub async fn ui_models_local(
    webview: Webview,
    settings: State<'_, SettingsStore>,
    kind: String,
) -> Result<Vec<String>, String> {
    guard(&webview)?;
    let s = settings.get();
    match kind.as_str() {
        "ollama" => {
            let url = s
                .providers
                .ollama
                .as_ref()
                .map(|o| o.url.clone())
                .unwrap_or_else(|| "http://localhost:11434".into());
            list_models(LocalKind::Ollama, &url).await
        }
        "lmstudio" => {
            let url = s
                .providers
                .lmstudio
                .as_ref()
                .map(|o| o.url.clone())
                .unwrap_or_else(|| "http://localhost:1234".into());
            list_models(LocalKind::LmStudio, &url).await
        }
        _ => Err("unknown local provider".into()),
    }
}

/// Tauri commands must take their State/params as individual arguments, so
/// >7 args is normal here; the clippy gate exempts command entry points.
#[allow(clippy::too_many_arguments)]
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
    let mut active_guard = active.0.lock().unwrap();
    if active_guard.is_some() {
        return Err("a task is already running — stop it first".into());
    }
    let ws = ws_from(&slot)?;
    let settings_snapshot = settings.get();
    let provider = build_provider(
        &app,
        &settings_snapshot,
        &adapters,
        webview_state.inner(),
        hub.inner(),
        relay.inner(),
        &provider_id,
    )?;

    let task_id = format!("t{}", uuid::Uuid::new_v4().simple());
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel();
    let shared = Arc::new(AgentShared {
        cmd_tx,
        cmd_rx: std::sync::Mutex::new(Some(cmd_rx)),
        state: std::sync::Mutex::new(crate::agent::AgentState::Idle),
        task_id: std::sync::Mutex::new(Some(task_id.clone())),
    });
    *active_guard = Some(shared.clone());

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
    drop(active_guard);
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
        let profile = settings
            .providers
            .web
            .iter()
            .find(|p| p.id == profile_id)
            .ok_or("profile not found")?;
        let adapter = adapters
            .list
            .lock()
            .unwrap()
            .iter()
            .find(|a| a.id == profile.adapter_id)
            .cloned()
            .ok_or("adapter missing")?;
        return Ok(Provider::Web(Box::new(crate::webprov::WebProvider {
            app: app.clone(),
            profile_id: profile_id.to_string(),
            adapter,
            hub: hub.clone(),
            state: webview_state.clone(),
        })));
    }
    match provider_id {
        "ollama" => {
            let cfg = settings
                .providers
                .ollama
                .clone()
                .ok_or("Ollama not configured — open Settings")?;
            Ok(Provider::Local(LocalProvider::new(
                app.clone(),
                LocalKind::Ollama,
                cfg,
            )))
        }
        "lmstudio" => {
            let cfg = settings
                .providers
                .lmstudio
                .clone()
                .ok_or("LM Studio not configured — open Settings")?;
            Ok(Provider::Local(LocalProvider::new(
                app.clone(),
                LocalKind::LmStudio,
                cfg,
            )))
        }
        "manual" => Ok(Provider::Manual(ManualProvider::new(
            app.clone(),
            relay.clone(),
        ))),
        other => Err(format!("unknown provider '{other}'")),
    }
}

#[tauri::command]
pub fn ui_task_stop(webview: Webview, active: State<'_, ActiveAgent>) -> Result<(), String> {
    guard(&webview)?;
    if let Some(shared) = active.get() {
        let _ = shared.cmd_tx.send(AgentCommand::Stop);
    }
    // E4: do NOT kill the user's interactive terminal sessions here — this is
    // the per-task Stop button. The emergency hotkey (lib::emergency_stop)
    // still kills everything, by design.
    Ok(())
}

/// Same argument-shape rationale as ui_task_start.
#[allow(clippy::too_many_arguments)]
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
    let last_prompt = prior
        .iter()
        .rev()
        .find(|e| e.kind == "user_prompt")
        .map(|e| e.text.clone())
        .ok_or("task has no prompt to continue")?;
    let ws = ws_from(&slot)?;
    let settings_snapshot = settings.get();
    let provider = build_provider(
        &app,
        &settings_snapshot,
        &adapters,
        webview_state.inner(),
        hub.inner(),
        relay.inner(),
        &provider_id,
    )?;
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
pub fn ui_approve(
    webview: Webview,
    active: State<'_, ActiveAgent>,
    decisions: Vec<CallDecision>,
) -> Result<(), String> {
    guard(&webview)?;
    let shared = active.get().ok_or("no running task")?;
    let _ = shared.cmd_tx.send(AgentCommand::Approve(decisions));
    Ok(())
}

#[tauri::command]
pub fn ui_relay_reply(
    webview: Webview,
    relay: State<'_, Arc<crate::providers::RelaySlot>>,
    text: String,
) -> Result<(), String> {
    guard(&webview)?;
    if !relay.deliver(text) {
        return Err("no manual relay is waiting for a reply right now".into());
    }
    Ok(())
}

#[tauri::command]
pub fn ui_webview_mode(
    webview: Webview,
    app: AppHandle,
    state: State<'_, Arc<WebviewState>>,
    mode: String,
) -> Result<(), String> {
    guard(&webview)?;
    match mode.as_str() {
        "provider" => webprov::set_visible(&app, &state, true),
        "chat" => {
            // A7: HIDE the webview, never destroy it — the page must not
            // reload when the user flips between Chat and Provider. It is
            // destroyed later only by explicit Close, profile change, or the
            // >10 min idle sweep (never while an agent task runs).
            webprov::hide_if_any(&app, &state);
        }
        other => return Err(format!("unknown mode {other}")),
    }
    Ok(())
}

#[tauri::command]
pub fn ui_webview_rect(
    webview: Webview,
    app: AppHandle,
    state: State<'_, Arc<WebviewState>>,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Result<(), String> {
    guard(&webview)?;
    webprov::apply_rect(&app, &state, webprov::Rect { x, y, w, h });
    Ok(())
}

#[tauri::command]
pub fn ui_terminal_create(
    webview: Webview,
    app: AppHandle,
    settings: State<'_, SettingsStore>,
    slot: State<'_, WorkspaceSlot>,
) -> Result<u32, String> {
    guard(&webview)?;
    let cwd = slot
        .0
        .lock()
        .unwrap()
        .clone()
        .map(|w| w.root().to_path_buf());
    crate::terminal::create(app, settings.get().shell, cwd)
}

#[tauri::command]
pub fn ui_terminal_write(
    webview: Webview,
    term: State<'_, TermState>,
    id: u32,
    data: String,
) -> Result<(), String> {
    guard(&webview)?;
    crate::terminal::write(&term, id, &data)
}

#[tauri::command]
pub fn ui_terminal_resize(
    webview: Webview,
    term: State<'_, TermState>,
    id: u32,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    guard(&webview)?;
    crate::terminal::resize(&term, id, rows, cols)
}

#[tauri::command]
pub fn ui_terminal_kill(
    webview: Webview,
    term: State<'_, TermState>,
    id: u32,
) -> Result<(), String> {
    guard(&webview)?;
    crate::terminal::kill(&term, id)
}

#[tauri::command]
pub fn ui_checkpoint_list(
    webview: Webview,
    slot: State<'_, WorkspaceSlot>,
) -> Result<Vec<crate::checkpoints::Checkpoint>, String> {
    guard(&webview)?;
    let ws = ws_from(&slot)?;
    crate::checkpoints::list(&ws)
}

#[tauri::command]
pub fn ui_checkpoint_create(
    webview: Webview,
    agent: State<'_, crate::agent::ActiveAgent>,
    slot: State<'_, WorkspaceSlot>,
    label: String,
) -> Result<crate::checkpoints::Checkpoint, String> {
    guard(&webview)?;
    let active_guard = agent.0.lock().unwrap();
    if active_guard.is_some() {
        return Err("cannot create a manual checkpoint while a task is active".into());
    }
    let ws = ws_from(&slot)?;
    crate::checkpoints::snapshot(&ws, &label)
}

#[tauri::command]
pub fn ui_checkpoint_restore_preview(
    webview: Webview,
    slot: State<'_, WorkspaceSlot>,
    agent: State<'_, crate::agent::ActiveAgent>,
    id: String,
) -> Result<crate::checkpoints::RestorePreview, String> {
    guard(&webview)?;
    let active_guard = agent.0.lock().unwrap();
    if active_guard.is_some() {
        return Err("stop the active task before restoring a checkpoint".into());
    }
    let ws = ws_from(&slot)?;
    crate::checkpoints::restore_preview(&ws, &id)
}

#[tauri::command]
pub fn ui_checkpoint_restore(
    webview: Webview,
    slot: State<'_, WorkspaceSlot>,
    agent: State<'_, crate::agent::ActiveAgent>,
    id: String,
) -> Result<crate::checkpoints::RestoreResult, String> {
    guard(&webview)?;
    let active_guard = agent.0.lock().unwrap();
    if active_guard.is_some() {
        return Err("stop the active task before restoring a checkpoint".into());
    }
    let ws = ws_from(&slot)?;
    crate::checkpoints::restore(&ws, &id)
}

#[tauri::command]
pub fn ui_history_tasks(
    webview: Webview,
    history: State<'_, Arc<HistoryStore>>,
) -> Result<Value, String> {
    guard(&webview)?;
    Ok(json!(history.list_tasks(100)))
}

#[tauri::command]
pub fn ui_history_open(
    webview: Webview,
    history: State<'_, Arc<HistoryStore>>,
    task_id: String,
) -> Result<Vec<TranscriptEntry>, String> {
    guard(&webview)?;
    history.read_transcript(&task_id, 400)
}

#[tauri::command]
pub fn ui_search_tasks(
    webview: Webview,
    history: State<'_, Arc<HistoryStore>>,
    q: String,
) -> Result<Value, String> {
    guard(&webview)?;
    let ql = q.to_lowercase();
    let matches: Vec<_> = history
        .list_tasks(500)
        .into_iter()
        .filter(|m| {
            m.title.to_lowercase().contains(&ql) || m.workspace.to_lowercase().contains(&ql)
        })
        .collect();
    Ok(json!(matches))
}

#[tauri::command]
pub fn ui_task_rename(
    webview: Webview,
    history: State<'_, Arc<HistoryStore>>,
    id: String,
    title: String,
) -> Result<Value, String> {
    guard(&webview)?;
    let clean = title.trim();
    if clean.is_empty() || clean.len() > 80 {
        return Err("title must be 1..=80 chars".into());
    }
    let dir = history.task_dir(&id);
    if !dir.exists() {
        return Err("task not found".into());
    }
    let meta_path = dir.join("meta.json");
    let bytes = std::fs::read(&meta_path).map_err(|e| e.to_string())?;
    let mut meta: TaskMeta =
        serde_json::from_slice(&bytes).map_err(|e| format!("failed to read task meta: {e}"))?;
    meta.title = clean.to_string();
    history.update_task(&meta).map_err(|e| e.to_string())?;
    Ok(json!({"id": id, "title": clean}))
}

#[tauri::command]
pub fn ui_task_delete(
    webview: Webview,
    history: State<'_, Arc<HistoryStore>>,
    id: String,
) -> Result<Value, String> {
    guard(&webview)?;
    history.delete_task(&id)?;
    Ok(json!({"removed": id}))
}

#[tauri::command]
pub fn ui_diff_get(
    webview: Webview,
    history: State<'_, Arc<HistoryStore>>,
    task_id: String,
    entry_id: u64,
) -> Result<Value, String> {
    guard(&webview)?;
    let entries = history.read_transcript(&task_id, 1000)?;
    let entry = entries
        .iter()
        .find(|e| e.id == entry_id)
        .ok_or("entry not found")?;
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
