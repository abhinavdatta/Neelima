//! All UI-facing commands. EVERY command label-checks its caller: only the
//! "ui" webview may invoke these. (The provider webview's capability grants
//! exactly one command — lb_bridge — and the app ACL manifest denies it
//! everything else anyway. This guard is the second wall.)

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Position, Size, State, Webview};

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
    // TEST-BUILD ONLY: the lib unit-test binary links this whole crate, and
    // the dialog plugin's rfd chain imports `TaskDialogIndirect` from
    // comctl32 v6. Cargo does not apply manifest workarounds to lib
    // UNIT-test targets (only integration tests), so the loader would bind
    // the ancient comctl32 and abort with STATUS_ENTRYPOINT_NOT_FOUND
    // (0xc0000139) before main runs — while BINS cannot take a second
    // manifest either (tauri-build's resource.lib already embeds one,
    // CVT1100). Dialogs never execute inside unit tests, so compile the
    // dialog chain out of test builds; production builds are unchanged.
    #[cfg(test)]
    {
        let _ = &app;
        Err("workspace picking is unavailable in test builds".into())
    }
    #[cfg(not(test))]
    {
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
    webprov::mount(&app, profile, &adapter, &state).await?;
    webprov::set_visible(&app, &state, true);
    Ok(())
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
            user_message: None,
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
    webprov::mount(&app, &profile_id, &adapter, &state).await?;
    // The user explicitly opened provider sign-in, so reveal the isolated
    // authentication view. Agent sends only mount/use it while hidden.
    webprov::set_visible(&app, &state, true);
    Ok(())
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

#[tauri::command]
pub fn ui_provider_clear_session(
    webview: Webview,
    app: AppHandle,
    state: State<'_, Arc<WebviewState>>,
    settings: State<'_, SettingsStore>,
    profile_id: String,
) -> Result<(), String> {
    guard(&webview)?;
    if !settings
        .get()
        .providers
        .web
        .iter()
        .any(|profile| profile.id == profile_id)
    {
        return Err("provider profile not found".into());
    }
    webprov::clear_profile_session(&app, &state, &profile_id)
}

/// Step 2 (I): metadata-only snapshot of recent request lifecycles across ALL
/// providers (browser web chats, local runtimes, manual relay): request ID,
/// provider, task/conversation identity, state, timing and coarse error
/// category. There is no field in here that can hold prompt or reply text.
#[tauri::command]
pub fn ui_request_log(
    webview: Webview,
    registry: State<'_, Arc<crate::request::RequestRegistry>>,
) -> Result<Value, String> {
    guard(&webview)?;
    Ok(Value::Array(registry.snapshot()))
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

    // Don't turn a page-load race into two long, silent RPC timeouts. A real
    // connection test requires the injected runtime to have announced ready.
    if !state.page_ready.load(std::sync::atomic::Ordering::Acquire) {
        return Ok(json!({
            "mounted": true,
            "connected": false,
            "status": "loading",
            "message": "The provider page has not finished loading yet. Keep the sign-in window open and test again in a moment.",
            "login_state": "loading",
            "reason": "provider runtime has not reported ready",
            "input_found": false,
            "send_button_found": false,
            "messages_found": false,
        }));
    }

    // Ping the page: a bridge ping alone does NOT mean chat is usable.
    *state.last_bridge_error.lock().unwrap() = None;
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
                    Ok(()) => match crate::bridge::BridgeHub::wait(rx, 8_000).await {
                        Ok(reply)
                            if reply["ok"] == true
                                && reply["value"]
                                    .as_str()
                                    .is_some_and(|value| value.starts_with("pong:")) =>
                        {
                            Some(started.elapsed().as_millis() as u64)
                        }
                        Ok(reply) => {
                            let error = reply["error"]
                                .as_str()
                                .unwrap_or("provider bridge returned an invalid ping response")
                                .to_string();
                            *state.last_bridge_error.lock().unwrap() = Some(error);
                            None
                        }
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

    if ping.is_none() {
        let reason = state
            .last_bridge_error
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| "provider page did not answer the bridge ping".into());
        return Ok(json!({
            "mounted": true,
            "connected": false,
            "status": "unreachable",
            "message": format!("Neelima cannot reach the provider page: {reason}. Reopen the sign-in window and try again."),
            "login_state": "unknown",
            "reason": reason,
            "ping_ms": null,
            "input_found": null,
            "send_button_found": null,
            "messages_found": null,
        }));
    }

    // Deep info from the page (selectors state).
    let (req_id2, nonce2, rx2) = hub.begin();
    let mut input_found = None;
    let mut send_found = None;
    let mut messages_found = None;
    let mut page_login = None;
    let mut page_reason = None;
    let mut page_info_error = None;
    let mut page_info_vis: Option<String> = None;
    let mut page_info_watch: Option<Value> = None;
    let mut page_info_turns: Option<Value> = None;
    let mut page_info_last_len: Option<u64> = None;
    let mut page_info_ms_since_send: Option<u64> = None;
    let mut matched_markers: Vec<String> = Vec::new();
    if let Some(wv) = app.get_webview(webprov::PROVIDER_LABEL) {
        let js = format!(
            "window.__LB__ && window.__LB__.call('page_info', null, {:?}, {:?})",
            req_id2, nonce2
        );
        if let Err(e) = wv.eval(js) {
            hub.cancel(&req_id2);
            page_info_error = Some(format!("page_info eval: {e}"));
        } else {
            match crate::bridge::BridgeHub::wait(rx2, 8_000).await {
                Ok(v) if v["ok"] == true => {
                    input_found = v["value"]["input_found"].as_bool();
                    send_found = v["value"]["send_button_found"].as_bool();
                    messages_found = v["value"]["messages_found"].as_bool();
                    page_login = v["value"]["login"]["state"].as_str().map(str::to_owned);
                    page_reason = v["value"]["login"]["reason"].as_str().map(str::to_owned);
                    page_info_vis = v["value"]["visibility_state"].as_str().map(str::to_owned);
                    page_info_watch = Some(v["value"]["watch"].clone());
                    page_info_turns = Some(v["value"]["turns"].clone());
                    page_info_last_len = v["value"]["last_assistant_len"].as_u64();
                    page_info_ms_since_send = v["value"]["ms_since_send"].as_u64();
                    matched_markers = v["value"]["markers"]
                        .as_object()
                        .map(|m| {
                            m.iter()
                                .filter(|(_, v)| {
                                    v.as_bool() == Some(true) || v.as_u64().unwrap_or(0) > 0
                                })
                                .map(|(k, _)| k.clone())
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                }
                Ok(v) => {
                    hub.cancel(&req_id2);
                    page_info_error = Some(
                        v["error"]
                            .as_str()
                            .unwrap_or("provider bridge returned an invalid page-info response")
                            .to_string(),
                    );
                }
                Err(e) => {
                    hub.cancel(&req_id2);
                    page_info_error = Some(format!("page_info: {e}"));
                }
            }
        }
    } else {
        hub.cancel(&req_id2);
        page_info_error = Some("provider webview disappeared during the test".into());
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
        crate::webprov::LoginState::Loading { reason, url } => {
            ("loading".into(), url.clone(), reason.clone())
        }
        crate::webprov::LoginState::Challenge { reason, url } => {
            ("challenge".into(), url.clone(), reason.clone())
        }
    };
    // Prefer page_info's fresh posture; the pushed state can lag during SPA
    // transitions. A ping plus a visible editable composer is the connection
    // criterion. We intentionally don't require a Send button on an empty chat.
    let effective_login = page_login.as_deref().unwrap_or(&login);
    let (status, message, connected): (&str, String, bool) = if let Some(error) =
        page_info_error.as_deref()
    {
        ("unreachable", format!("Neelima reached the provider bridge but could not inspect chat readiness: {error}. Reopen the sign-in window and try again."), false)
    } else if input_found == Some(true) && effective_login == "logged_in" {
        (
            "ready",
            "Connection works. Neelima reached the provider chat and found its message composer."
                .into(),
            true,
        )
    } else if effective_login == "logged_out" {
        ("sign_in_required", "The provider page is reachable, but you need to sign in there before Neelima can use chat.".into(), false)
    } else if effective_login == "challenge" {
        ("verification_required", "The provider requires verification. Complete it in the sign-in window, then test again.".into(), false)
    } else if input_found == Some(false) {
        ("composer_missing", "The provider page is reachable, but its chat composer was not found. Refresh the sign-in window; if this persists, the website adapter may need an update. No prompt was sent.".into(), false)
    } else if input_found == Some(true) {
        // Composer exists but authentication could not be confirmed either way.
        // Surface the page's own reason (e.g. "no authenticated account marker
        // was detected") so the user knows the session is unverified, not ready.
        (
            "unknown",
            format!(
                "The provider page shows a message composer, but Neelima could not confirm a signed-in session. {}. If chat does not work, reopen the sign-in window, complete sign-in there, then test again.",
                page_reason.as_deref().unwrap_or("the page did not report why")
            ),
            false,
        )
    } else {
        ("unknown", "The provider page answered, but Neelima could not confirm a usable signed-in chat. Reopen the sign-in window and test again.".into(), false)
    };
    let report = json!({
        "mounted": true,
        "connected": connected,
        "status": status,
        "message": message,
        "profile": profile_id,
        "adapter": adapter_id,
        "adapter_name": adapter.as_ref().map(|a| a.name.clone()).unwrap_or_default(),
        "url": url,
        "auth_domains": adapter.as_ref().map(|a| a.auth_domains.clone()).unwrap_or_default(),
        "login_url_patterns": adapter.as_ref().map(|a| a.login_url_patterns.clone()).unwrap_or_default(),
        "ping_ms": ping,
        "login_state": effective_login,
        "reason": page_info_error.or(page_reason).unwrap_or(reason),
        "input_found": input_found,
        "send_button_found": send_found,
        "messages_found": messages_found,
        "visibility_state": page_info_vis,
        "watch": page_info_watch,
        "turns": page_info_turns,
        "last_assistant_len": page_info_last_len,
        "ms_since_send": page_info_ms_since_send,
        "matched_markers": matched_markers,
        "last_bridge_error": *state.last_bridge_error.lock().unwrap(),
        "bridge_log_path": hub.log_path().map(|p| p.display().to_string()),
        "bridge_log_write_error": hub.log_write_error(),
        "bridge_log": hub.events().iter().rev().take(30).rev().cloned().collect::<Vec<_>>(),
        "settings_sample": {
            "adapter_domains": adapter.as_ref().map(|a| a.allowed_domain.clone()).unwrap_or_default(),
            "profile": settings.get().providers.web.iter().find(|p| p.id == profile_id).map(|p| p.name.clone()).unwrap_or_default(),
        },
    });
    log_provider_diagnostic(&report);
    Ok(report)
}

/// Persist sanitized connection diagnostics to the app log (item 6): metadata
/// only — counts, states, timings. Never page text, prompts, or tool args.
pub fn log_provider_diagnostic(report: &Value) {
    let summary = format!(
        "status={} login={} input={} send={} vis={} layout={} watch_target={:?} watch_callbacks={} users={} assistants={} ms_since_send={:?}",
        report["status"].as_str().unwrap_or("?"),
        report["login_state"].as_str().unwrap_or("?"),
        report["input_found"].as_bool().unwrap_or(false),
        report["send_button_found"].as_bool().unwrap_or(false),
        report["visibility_state"].as_str().unwrap_or("?"),
        report["reply_layout"].as_str().unwrap_or("?"),
        report["watch"]["attached_target"].as_str(),
        report["watch"]["callbacks"].as_u64().unwrap_or(0),
        report["turns"]["users"].as_u64().unwrap_or(0),
        report["turns"]["assistants"].as_u64().unwrap_or(0),
        report["ms_since_send"].as_u64(),
    );
    let _ = crate::app_log::write("provider-diagnose", &summary);
}

/// Manual "I'm signed in" override (item 4): the user asserts the embedded
/// session is authenticated after completing sign-in; recorded as LoggedIn.
#[tauri::command]
pub fn ui_provider_mark_signed_in(
    webview: Webview,
    state: State<'_, Arc<WebviewState>>,
) -> Result<(), String> {
    guard(&webview)?;
    let url = match &*state.login.lock().unwrap() {
        crate::webprov::LoginState::LoggedIn { url } => url.clone(),
        crate::webprov::LoginState::LoggedOut { url }
        | crate::webprov::LoginState::Unknown { url, .. }
        | crate::webprov::LoginState::Loading { url, .. }
        | crate::webprov::LoginState::Challenge { url, .. } => url.clone(),
    };
    *state.login.lock().unwrap() = crate::webprov::LoginState::LoggedIn { url };
    state.login_changed.notify_waiters();
    Ok(())
}

/// "Capture current reply" (item 7): one-shot read of the provider page's
/// current reply candidate; delivers it into the reply pipeline if present.
#[tauri::command]
pub async fn ui_capture_reply(
    webview: Webview,
    app: AppHandle,
    hub: State<'_, Arc<BridgeHub>>,
    state: State<'_, Arc<WebviewState>>,
) -> Result<Value, String> {
    guard(&webview)?;
    if !state.page_ready.load(std::sync::atomic::Ordering::Acquire) {
        return Ok(json!({"delivered": false, "reason": "provider page is not ready"}));
    }
    let baseline = state
        .response_baseline
        .load(std::sync::atomic::Ordering::Acquire);
    match crate::webprov::capture_reply_detail(&app, &hub, 8_000).await {
        Ok(Some(detail)) => {
            let text = detail["text"].as_str().unwrap_or("").trim().to_string();
            if detail["has_reply"].as_bool() != Some(true) || text.is_empty() {
                // Persist the structural outline (tags/attribute names/lengths
                // only) so an unrecognised live layout can be fixed from the
                // log instead of another round of selector guessing.
                let outline = serde_json::to_string(&detail["dom"]).unwrap_or_default();
                let _ = crate::app_log::write(
                    "capture-miss",
                    &format!("{} | dom={}", capture_reason(&detail), outline),
                );
                return Ok(json!({
                    "delivered": false,
                    "reason": capture_reason(&detail),
                    "dom": detail["dom"].clone()
                }));
            }
            {
                let mut last = state.last_message.lock().unwrap();
                let seq = last.0.max(baseline) + 1;
                *last = (seq, text.clone());
            }
            state.message_notify.notify_one();
            let _ = app.emit(
                "evt",
                json!({"kind": "assistant-captured", "at_ms": 0, "len": text.len()}),
            );
            Ok(json!({"delivered": true, "len": text.len()}))
        }
        Ok(None) => Ok(json!(
            {"delivered": false, "reason": "the provider page did not answer the capture request — open the provider window and check that the conversation is still open"}
        )),
        Err(e) => Ok(json!({"delivered": false, "reason": e})),
    }
}

/// Why the last capture produced no reply. METADATA ONLY (layout family, turn
/// counts, streaming state) — never page text — so a live "the answer is right
/// there" failure is diagnosable instead of a bare "no reply yet".
fn capture_reason(detail: &Value) -> String {
    let layout = detail["layout"].as_str().unwrap_or("unknown");
    let assistants = detail["assistant_count"].as_u64().unwrap_or(0);
    let users = detail["user_count"].as_u64().unwrap_or(0);
    let streaming = detail["stop_visible"].as_bool() == Some(true);
    let hint = if layout == "none" {
        "; the provider page layout was not recognised at all — this is a markup change, not a missing reply"
    } else if assistants == 0 {
        "; no assistant turn was found in the page DOM"
    } else if streaming {
        "; the provider is still generating"
    } else {
        "; the assistant turn was found but carried no text"
    };
    // Compact structural evidence (tag/attribute NAMES only, never page text):
    // this is what makes the next report actionable instead of another guess.
    let shape = dom_shape(detail);
    format!(
        "no complete reply is visible on the provider page yet (layout: {layout}, assistant turns: {assistants}, user turns: {users}){hint}{shape}"
    )
}

/// ` — newest block: div.markdown.prose (len 0); ancestors: main > div.flex`
fn dom_shape(detail: &Value) -> String {
    let block = detail["dom"]["blocks"]
        .as_array()
        .and_then(|b| b.last())
        .cloned()
        .unwrap_or(Value::Null);
    if block.is_null() {
        return String::new();
    }
    let tag = block["tag"].as_str().unwrap_or("?");
    let len = block["text_len"].as_u64().unwrap_or(0);
    let mut label = tag.to_string();
    if let Some(attrs) = block["attrs"].as_array() {
        for attr in attrs {
            let attr = attr.as_str().unwrap_or("");
            // Keep only the class hint: identifiers can carry account or chat
            // names, so data-* values stay in the log, not the chat card.
            if let Some(classes) = attr.strip_prefix("class=") {
                label.push('.');
                label.push_str(classes);
                break;
            }
        }
    }
    let chain = detail["dom"]["chain"]
        .as_array()
        .map(|levels| {
            levels
                .iter()
                .take(4)
                .map(|l| l["tag"].as_str().unwrap_or("?"))
                .collect::<Vec<_>>()
                .join(" > ")
        })
        .unwrap_or_default();
    if chain.is_empty() {
        format!(" — newest block: {label} (len {len})")
    } else {
        format!(" — newest block: {label} (len {len}); ancestors: {chain}")
    }
}

/// The harmless prompt used by the one-click READY check (Phase I).
pub const PROVIDER_READY_PROMPT: &str =
    "For this connectivity check, reply with exactly READY. Do not use tools.";

/// One-click connectivity check for a browser provider: sends the harmless
/// READY prompt through the REAL send/watch pipeline and returns the captured
/// reply, so live verification is evidence from the app instead of a guess.
/// It does not start an agent task, touch the workspace, or resend on failure.
#[tauri::command]
pub async fn ui_provider_probe(
    webview: Webview,
    app: AppHandle,
    provider_id: String,
) -> Result<Value, String> {
    guard(&webview)?;
    // Resolve managed state here instead of taking nine command arguments.
    let active: State<'_, ActiveAgent> = app.state();
    let settings: State<'_, SettingsStore> = app.state();
    let adapters: State<'_, AdaptersState> = app.state();
    let state: State<'_, Arc<WebviewState>> = app.state();
    let hub: State<'_, Arc<BridgeHub>> = app.state();
    let relay: State<'_, Arc<crate::providers::RelaySlot>> = app.state();
    if active.get().is_some() {
        return Err("a task is running — stop it before running the READY check".into());
    }
    if !provider_id.starts_with("web:") {
        return Err("the READY check is available for browser providers only".into());
    }
    let settings = settings.get();
    let mut provider = build_provider(
        &app,
        &settings,
        &adapters,
        state.inner(),
        hub.inner(),
        relay.inner(),
        &provider_id,
    )?;
    let Provider::Web(w) = &mut provider else {
        return Err("the READY check is available for browser providers only".into());
    };
    // Bound the probe: a silent page must not hold the check for the full
    // provider deadline (default 7 minutes).
    w.adapter.response_timeout_ms = w.adapter.response_timeout_ms.min(90_000);
    // Keep the provider webview alive for the duration of the check.
    *state.task_active.lock().unwrap() = true;
    let started = std::time::Instant::now();
    let outcome = async {
        w.send(
            "neelima-ready-check",
            "neelima-ready-check",
            PROVIDER_READY_PROMPT,
            false,
        )
        .await
        .map_err(|e| e.message())?;
        w.wait_reply(Arc::new(tokio::sync::Notify::new())).await
    }
    .await;
    *state.task_active.lock().unwrap() = false;
    match outcome {
        Ok(reply) => {
            let request_id = w.state.active_request.lock().unwrap().clone();
            Ok(json!({
                "ok": true,
                "ready": reply.trim().eq_ignore_ascii_case("READY"),
                "reply": reply,
                "elapsed_ms": started.elapsed().as_millis() as u64,
                "request_id": request_id,
            }))
        }
        Err(e) => Err(e),
    }
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

/// Step 3 preview: run the exact selection the send path would run, so the list
/// the user inspects and vetoes is the list that is attached to the prompt.
/// Returns metadata only (paths, line ranges, sizes) — never file contents.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn ui_context_preview(
    webview: Webview,
    slot: State<'_, WorkspaceSlot>,
    settings: State<'_, SettingsStore>,
    history: State<'_, Arc<HistoryStore>>,
    prompt: String,
    provider_id: String,
    exclude: Vec<String>,
    task_id: Option<String>,
) -> Result<Value, String> {
    guard(&webview)?;
    let settings = settings.get();
    let ws = ws_from(&slot)?;
    let kind = context_kind_for(&settings, &provider_id)?;
    let prior_prompts: Vec<String> = match task_id.as_deref() {
        Some(task_id) => history
            .read_transcript(task_id, 100)?
            .into_iter()
            .filter(|e| e.kind == "user_prompt")
            .map(|e| e.text)
            .collect(),
        None => Vec::new(),
    };
    let prompt: String = prompt.chars().take(20_000).collect();
    let query = crate::context::query_for(&prompt, &prior_prompts);
    let sel = crate::context::select_for(
        &ws,
        &query,
        &settings,
        kind,
        &crate::context::Options::sanitized(true, exclude),
    );
    Ok(json!({
        "enabled": settings.context.enabled,
        "budget_bytes": sel.budget_bytes,
        "bytes": sel.bytes,
        "considered": sel.considered,
        "truncated": sel.truncated,
        "scan_capped": sel.scan_capped,
        "omitted": sel.omitted,
        "excluded_by_user": sel.excluded_by_user,
        "skipped": sel.skipped,
        "files": sel.files,
    }))
}

fn context_kind_for(
    settings: &Settings,
    provider_id: &str,
) -> Result<crate::context::Kind, String> {
    if let Some(profile_id) = provider_id.strip_prefix("web:") {
        return if settings.providers.web.iter().any(|p| p.id == profile_id) {
            Ok(crate::context::Kind::Web)
        } else {
            Err("profile not found".into())
        };
    }
    match provider_id {
        "ollama" | "lmstudio" => Ok(crate::context::Kind::Local),
        "manual" => Ok(crate::context::Kind::Manual),
        other => Err(format!("unknown provider '{other}'")),
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
    skill_ids: Vec<String>,
    skill_budget: usize,
    request_id: String,
    context: Option<crate::context::Options>,
) -> Result<String, String> {
    guard(&webview)?;
    if request_id.len() != 32 || !request_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("invalid task start request ID".into());
    }
    let mut active_guard = active.0.lock().unwrap();
    if active_guard.is_some() {
        return Err("a task is already running — stop it first".into());
    }
    // Step 3: the composer may disable context or veto individual files. The
    // list can only remove files; the backend still decides what is read.
    let context_options = context
        .map(|c| crate::context::Options::sanitized(c.enabled, c.exclude))
        .unwrap_or_default();
    let ws = ws_from(&slot)?;
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let app_skills = config_dir.join("skills");
    let workspace_skills = ws.root().join(".neelima").join("skills");
    crate::skills::validate_root_under(&config_dir, &app_skills)?;
    crate::skills::validate_root_under(ws.root(), &workspace_skills)?;
    let skill_context = crate::skills::task_context(
        &app_skills,
        Some(&workspace_skills),
        &skill_ids,
        skill_budget,
    )?;
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

    let task_id = uuid::Uuid::new_v4().simple().to_string();
    let response_task_id = task_id.clone();
    let conversation_id = task_id.clone();
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
        conversation_id,
        prompt,
        skill_context,
        context: context_options,
        provider,
        ws,
        settings: settings_snapshot,
        history: history.inner().clone(),
        webview_state: webview_state.inner().clone(),
        shared,
        prior_entries: Vec::new(),
    };
    let _ = app.emit(
        crate::agent::EVT,
        json!({"kind":"task-started", "task_id":response_task_id, "request_id":request_id}),
    );
    tauri::async_runtime::spawn(crate::agent::run(input));
    drop(active_guard);
    Ok(response_task_id)
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
        let mut adapter = adapters
            .list
            .lock()
            .unwrap()
            .iter()
            .find(|a| a.id == profile.adapter_id)
            .cloned()
            .ok_or("adapter missing")?;
        if let Some(url) = profile.url.as_deref() {
            crate::adapters::validate_profile_url(url, &adapter.allowed_domain)?;
            adapter.url = url.to_string();
        }
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
    prompt: String,
    request_id: String,
    context: Option<crate::context::Options>,
) -> Result<String, String> {
    guard(&webview)?;
    if request_id.len() != 32 || !request_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("invalid task start request ID".into());
    }
    let mut active_guard = active.0.lock().unwrap();
    if active_guard.is_some() {
        return Err("a task is already running — stop it first".into());
    }
    if prompt.trim().is_empty() {
        return Err("enter a message to continue this task".into());
    }
    let prior = history.read_transcript(&task_id, 100)?;
    if prior.iter().all(|e| e.kind != "user_prompt") {
        return Err("task has no prompt to continue".into());
    }
    let ws = ws_from(&slot)?;
    let source_task = history.read_task_meta(&task_id)?;
    let conversation_id = if source_task.conversation_id.is_empty() {
        source_task.id.clone()
    } else {
        source_task.conversation_id.clone()
    };
    if source_task.workspace != ws.display_name() {
        return Err("select the workspace used by this task before continuing it".into());
    }
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
    let new_task_id = uuid::Uuid::new_v4().simple().to_string();
    let response_task_id = new_task_id.clone();
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel();
    let shared = Arc::new(AgentShared {
        cmd_tx,
        cmd_rx: std::sync::Mutex::new(Some(cmd_rx)),
        state: std::sync::Mutex::new(crate::agent::AgentState::Idle),
        task_id: std::sync::Mutex::new(Some(new_task_id.clone())),
    });
    *active_guard = Some(shared.clone());
    let input = AgentInput {
        app: app.clone(),
        task_id: new_task_id,
        conversation_id,
        prompt,
        skill_context: String::new(),
        context: context
            .map(|c| crate::context::Options::sanitized(c.enabled, c.exclude))
            .unwrap_or_default(),
        provider,
        ws,
        settings: settings_snapshot,
        history: history.inner().clone(),
        webview_state: webview_state.inner().clone(),
        shared,
        prior_entries: prior,
    };
    let _ = app.emit(
        crate::agent::EVT,
        json!({"kind":"task-started", "task_id":response_task_id, "request_id":request_id}),
    );
    tauri::async_runtime::spawn(crate::agent::run(input));
    drop(active_guard);
    Ok(response_task_id)
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

/// Re-fit the UI webview to the actual window (physical pixels). The webview
/// must track window resizes exactly: a stale, larger webview makes viewport
/// units (vw/vh) oversized, which pushed centered modals past the visible
/// window edge. Invoked from the Rust resize handler AND from the frontend's
/// own window-resize listener as an independent safety path.
#[tauri::command]
pub fn ui_sync_viewport(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_window("main") else {
        return Err("main window missing".into());
    };
    let size = window.inner_size().map_err(|e| e.to_string())?;
    if let Some(wv) = app.get_webview("ui") {
        let _ = wv.set_size(Size::Physical(tauri::PhysicalSize::new(
            size.width.max(1),
            size.height.max(1),
        )));
        let _ = wv.set_position(Position::Physical(tauri::PhysicalPosition::new(0, 0)));
    }
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
    if !crate::history::valid_task_id(&id) {
        return Err("invalid task ID".into());
    }
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

fn skill_root(
    app: &AppHandle,
    slot: &WorkspaceSlot,
    location: &str,
) -> Result<std::path::PathBuf, String> {
    match location {
        "app" => {
            let base = app.path().app_config_dir().map_err(|e| e.to_string())?;
            let root = base.join("skills");
            crate::skills::validate_root_under(&base, &root)?;
            Ok(root)
        }
        "workspace" => {
            let base = ws_from(slot)?.root().to_path_buf();
            let root = base.join(".neelima").join("skills");
            crate::skills::validate_root_under(&base, &root)?;
            Ok(root)
        }
        _ => Err("skill location must be app or workspace".into()),
    }
}

#[tauri::command]
pub fn ui_skills_list(
    webview: Webview,
    app: AppHandle,
    slot: State<'_, WorkspaceSlot>,
) -> Result<Vec<crate::skills::InstalledSkill>, String> {
    guard(&webview)?;
    let mut skills = crate::skills::installed(&skill_root(&app, &slot, "app")?, "app")?;
    if slot.0.lock().unwrap().is_some() {
        skills.extend(crate::skills::installed(
            &skill_root(&app, &slot, "workspace")?,
            "workspace",
        )?);
    }
    Ok(skills)
}

#[tauri::command]
pub async fn ui_skill_preview(
    webview: Webview,
    app: AppHandle,
    slot: State<'_, WorkspaceSlot>,
    repo_url: String,
    branch: String,
    path: String,
    location: String,
) -> Result<crate::skills::SkillPreview, String> {
    guard(&webview)?;
    let root = skill_root(&app, &slot, &location)?;
    crate::skills::preview(&repo_url, &branch, &path, &root).await
}

#[tauri::command]
pub async fn ui_skill_install(
    webview: Webview,
    app: AppHandle,
    slot: State<'_, WorkspaceSlot>,
    preview: crate::skills::SkillPreview,
    location: String,
    replace_existing: bool,
) -> Result<crate::skills::InstalledSkill, String> {
    guard(&webview)?;
    let root = skill_root(&app, &slot, &location)?;
    let mut result = crate::skills::install(&preview, &root, replace_existing).await?;
    result.location = location;
    Ok(result)
}

#[tauri::command]
pub fn ui_skill_set_enabled(
    webview: Webview,
    app: AppHandle,
    slot: State<'_, WorkspaceSlot>,
    location: String,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    guard(&webview)?;
    crate::skills::set_enabled(&skill_root(&app, &slot, &location)?, &id, enabled)
}

#[tauri::command]
pub fn ui_skill_uninstall(
    webview: Webview,
    app: AppHandle,
    slot: State<'_, WorkspaceSlot>,
    location: String,
    id: String,
) -> Result<(), String> {
    guard(&webview)?;
    crate::skills::uninstall(&skill_root(&app, &slot, &location)?, &id)
}

#[tauri::command]
pub fn ui_skill_reveal(
    webview: Webview,
    app: AppHandle,
    slot: State<'_, WorkspaceSlot>,
    location: String,
    id: String,
) -> Result<(), String> {
    guard(&webview)?;
    crate::skills::safe_skill_id(&id)?;
    let dir = skill_root(&app, &slot, &location)?.join(&id);
    if !dir.join(".neelima-skill.json").is_file() {
        return Err("installed skill not found".into());
    }
    #[cfg(windows)]
    {
        crate::procspawn::hidden_std("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        crate::procspawn::hidden_std("open")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        crate::procspawn::hidden_std("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn ui_skill_update_preview(
    webview: Webview,
    app: AppHandle,
    slot: State<'_, WorkspaceSlot>,
    location: String,
    id: String,
) -> Result<crate::skills::SkillPreview, String> {
    guard(&webview)?;
    crate::skills::safe_skill_id(&id)?;
    let root = skill_root(&app, &slot, &location)?;
    let list = crate::skills::installed(&root, &location)?;
    let skill = list
        .into_iter()
        .find(|s| s.id == id)
        .ok_or("installed skill not found")?;
    crate::skills::preview(
        &format!("https://github.com/{}", skill.source_repo),
        &skill.branch,
        &skill.source_path,
        &root,
    )
    .await
}

#[tauri::command]
pub fn ui_skill_read(
    webview: Webview,
    app: AppHandle,
    slot: State<'_, WorkspaceSlot>,
    location: String,
    id: String,
) -> Result<String, String> {
    guard(&webview)?;
    crate::skills::read_skill(&skill_root(&app, &slot, &location)?, &id)
}

#[tauri::command]
pub fn ui_open_github(webview: Webview, url: String) -> Result<(), String> {
    guard(&webview)?;
    let parsed = validate_github_url(&url)?;
    #[cfg(windows)]
    {
        crate::procspawn::hidden_std("rundll32")
            .arg("url.dll,FileProtocolHandler")
            .arg(parsed.as_str())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        crate::procspawn::hidden_std("open")
            .arg(parsed.as_str())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        crate::procspawn::hidden_std("xdg-open")
            .arg(parsed.as_str())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn validate_github_url(url: &str) -> Result<tauri::Url, String> {
    let parsed = tauri::Url::parse(url).map_err(|_| "invalid GitHub URL")?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("github.com")
        || !matches!(parsed.port(), None | Some(443))
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("only HTTPS github.com links on the default port can be opened".into());
    }
    Ok(parsed)
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

#[cfg(test)]
mod ready_check_tests {
    use super::PROVIDER_READY_PROMPT;

    /// The Phase I connectivity check must stay harmless and exact; a probe
    /// that asks the model for more could trigger tools or mutate a workspace.
    #[test]
    fn ready_check_prompt_is_exact_and_read_only() {
        assert_eq!(
            PROVIDER_READY_PROMPT,
            "For this connectivity check, reply with exactly READY. Do not use tools."
        );
        assert!(!PROVIDER_READY_PROMPT.contains("write"));
    }
}

#[cfg(test)]
mod github_url_tests {
    use super::validate_github_url;

    #[test]
    fn accepts_https_github_links() {
        assert!(validate_github_url("https://github.com/search?q=SKILL.md").is_ok());
        assert!(validate_github_url("https://github.com:443/org/repo").is_ok());
    }

    #[test]
    fn rejects_non_github_or_unsafe_urls() {
        for url in [
            "http://github.com/org/repo",
            "https://github.com.evil.example/org/repo",
            "https://user@github.com/org/repo",
            "https://github.com:8443/org/repo",
            "javascript:alert(1)",
        ] {
            assert!(validate_github_url(url).is_err(), "accepted {url}");
        }
    }
}

#[cfg(test)]
mod capture_diagnostics_tests {
    use super::capture_reason;
    use serde_json::json;

    /// "The answer is right there but Neelima says there is none" must explain
    /// WHICH detection family matched, without leaking any page text.
    #[test]
    fn an_unrecognised_layout_is_named_as_a_markup_change() {
        let reason = capture_reason(&json!({
            "has_reply": false,
            "text": "secret answer text",
            "layout": "none",
            "assistant_count": 0,
            "user_count": 2,
            "stop_visible": false
        }));
        assert!(reason.contains("layout: none"));
        assert!(reason.contains("markup change"), "got: {reason}");
        assert!(!reason.contains("secret answer text"), "metadata only");
    }

    #[test]
    fn a_still_streaming_or_textless_turn_is_distinguished() {
        let streaming = capture_reason(&json!({
            "layout": "role", "assistant_count": 1, "user_count": 1, "stop_visible": true
        }));
        assert!(streaming.contains("still generating"), "got: {streaming}");
        let textless = capture_reason(&json!({
            "layout": "turns", "assistant_count": 1, "user_count": 1, "stop_visible": false
        }));
        assert!(textless.contains("carried no text"), "got: {textless}");
        let no_turn = capture_reason(&json!({
            "layout": "adapter", "assistant_count": 0, "user_count": 1, "stop_visible": false
        }));
        assert!(no_turn.contains("no assistant turn"), "got: {no_turn}");
    }

    /// The card must carry enough STRUCTURE to fix an unknown layout, and no
    /// page text whatsoever.
    #[test]
    fn the_failure_reason_reports_the_dom_shape_without_text() {
        let reason = capture_reason(&json!({
            "layout": "content",
            "assistant_count": 1,
            "user_count": 1,
            "stop_visible": false,
            "text": "",
            "dom": {
                "blocks": [{ "tag": "div", "attrs": ["class=markdown.prose", "data-message-id=abc"], "text_len": 0 }],
                "chain": [{ "tag": "main" }, { "tag": "div" }, { "tag": "section" }]
            }
        }));
        assert!(
            reason.contains("newest block: div.markdown.prose"),
            "got: {reason}"
        );
        assert!(reason.contains("len 0"), "got: {reason}");
        assert!(
            reason.contains("ancestors: main > div > section"),
            "got: {reason}"
        );
        assert!(
            !reason.contains("abc"),
            "data-* values stay out of the card"
        );
    }
}
