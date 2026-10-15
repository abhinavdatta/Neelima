//! Web provider: drives the embedded provider web chat through the adapter
//! runtime. ONE provider webview alive at a time; when hidden or unused it is
//! DESTROYED (the profile's data directory persists, so logins survive).
//! Per-profile isolation: data_directory (Windows/Linux) or
//! data_store_identifier (macOS >= 14; WKWebView has no per-webview data dir).

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::{Manager, Position, Size, WebviewUrl, WebviewBuilder, Emitter};
use tokio::sync::Notify;

use crate::adapters::Adapter;
use crate::bridge::BridgeHub;

pub const PROVIDER_LABEL: &str = "provider";

#[derive(Default)]
pub struct WebviewState {
    /// The currently-mounted provider webview session, if any.
    pub mounted: Mutex<Option<MountedProfile>>,
    /// Provider pane geometry in PHYSICAL pixels relative to the window client area.
    pub rect: Mutex<Rect>,
    /// Manual-relay fallback active for the current provider.
    pub manual_fallback: Mutex<bool>,
    /// Inspector mode target for capture.
    pub inspector: Mutex<Option<InspectorSession>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MountedProfile {
    pub profile_id: String,
    pub adapter_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

#[derive(Debug, Clone)]
pub struct InspectorSession {
    pub req_id: String,
    pub kind: String,
    pub selectors: Vec<(String, String)>,
    pub name: String,
    pub url: String,
}

fn data_dir_for(app: &tauri::AppHandle, profile_id: &str) -> Result<std::path::PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("provider-profiles")
        .join(profile_id);
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    Ok(base)
}

/// 16-byte stable store id for macOS WKWebsiteDataStore (per-profile isolation).
#[cfg(target_os = "macos")]
fn store_id(profile_id: &str) -> [u8; 16] {
    let mut out = [0u8; 16];
    let mut h1: u64 = 0xcbf29ce484222325;
    let mut h2: u64 = 0x9e3779b97f4a7c15;
    for b in profile_id.as_bytes() {
        h1 ^= *b as u64;
        h1 = h1.wrapping_mul(0x100000001b3);
        h2 = h2.wrapping_add((*b as u64).wrapping_mul(31)).rotate_left(7);
    }
    out[..8].copy_from_slice(&h1.to_le_bytes());
    out[8..].copy_from_slice(&h2.to_le_bytes());
    out
}

pub fn injection_script(adapter: &Adapter) -> String {
    let cfg = serde_json::to_string(adapter).unwrap_or_else(|_| "{}".into());
    format!("window.__LB_ADAPTER__ = {cfg};\n{}", include_str!("adapter_runtime.js"))
}

#[derive(Clone)]
pub struct WebProvider {
    pub app: tauri::AppHandle,
    pub profile_id: String,
    pub adapter: Adapter,
    pub hub: Arc<BridgeHub>,
    pub state: Arc<WebviewState>,
}

impl WebProvider {
    pub fn describe(&self) -> String {
        format!("{} ({})", self.adapter.name, self.adapter.url)
    }

    fn rpc(&self, method: &str, arg: &Value, timeout_ms: u64) -> impl std::future::Future<Output = Result<Value, String>> + '_ {
        let app = self.app.clone();
        let hub = self.hub.clone();
        let method = method.to_string();
        let arg = arg.to_string();
        async move {
            let wv = app.get_webview(PROVIDER_LABEL).ok_or("provider webview is not open")?;
            let (id, rx) = hub.begin();
            let js = format!(
                "window.__LB__ && window.__LB__.call({:?}, {:?}, {:?})",
                method, arg, id
            );
            wv.eval(js).map_err(|e| format!("eval failed: {e}"))?;
            BridgeHub::wait(rx, timeout_ms).await
        }
    }

    async fn rpc_or_timeout(&self, method: &str, arg: Value, timeout_ms: u64) -> Result<Value, String> {
        self.rpc(method, &arg, timeout_ms).await
    }

    pub async fn send(&mut self, text: &str) -> Result<(), String> {
        if !is_mounted(&self.state, &self.profile_id) {
            mount(&self.app, &self.profile_id, &self.adapter, &self.state).await?;
        }
        let logged = self
            .rpc_or_timeout("is_logged_in", json!(null), 15_000)
            .await
            .ok()
            .and_then(|v| v.get("value").cloned())
            .map(|v| v.as_bool().unwrap_or(false))
            .unwrap_or(false);
        if !logged {
            let _ = self.app.emit("evt", json!({"kind": "provider-login-required", "adapter": self.adapter.name}));
            // First-class fallback per spec: manual relay still completes the task.
            self.state.manual_fallback_store(true);
            return Err("NEEDS_LOGIN".into());
        }
        let _ = self.rpc_or_timeout("new_chat", json!(null), 10_000).await;
        let sent = self
            .rpc_or_timeout("send_message", json!({"text": text}), 30_000)
            .await
            .map_err(|e| format!("send failed: {e} — falling back to manual relay is available"))?;
        if sent.get("error").is_some() {
            return Err(format!("send failed: {}", sent["error"].as_str().unwrap_or("?")));
        }
        Ok(())
    }

    pub async fn wait_reply(&mut self, cancel: Arc<Notify>) -> Result<String, String> {
        let timeout = self.adapter.response_timeout_ms;
        let done = tokio::select! {
            r = self.rpc_or_timeout("wait_response", json!({"timeout_ms": timeout}), timeout + 30_000) => r,
            _ = cancel.notified() => return Err("stopped".into()),
        };
        let complete = done
            .map_err(|e| format!("wait_response: {e}"))
            .and_then(|v| {
                if v.get("error").is_some() {
                    Err(v["error"].as_str().unwrap_or("unknown").to_string())
                } else {
                    Ok(())
                }
            });
        if let Err(e) = complete {
            return Err(e);
        }
        let reply = self
            .rpc_or_timeout("get_last_assistant", json!(null), 30_000)
            .await
            .map_err(|e| format!("get_last_assistant: {e}"))?;
        let text = reply
            .get("value")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if text.trim().is_empty() {
            return Err("extracted reply was empty — adapter selectors may be stale; use the Adapter Inspector or manual relay".into());
        }
        Ok(text)
    }
}

impl WebviewState {
    pub fn manual_fallback_store(&self, on: bool) {
        *self.manual_fallback.lock().unwrap() = on;
    }
}

pub fn is_mounted(state: &WebviewState, profile_id: &str) -> bool {
    state
        .mounted
        .lock()
        .unwrap()
        .as_ref()
        .map(|m| m.profile_id == profile_id)
        .unwrap_or(false)
}

/// Create (or re-point) the single provider webview. Destroys any previous one.
pub async fn mount(
    app: &tauri::AppHandle,
    profile_id: &str,
    adapter: &Adapter,
    state: &WebviewState,
) -> Result<(), String> {
    unmount_if_any(app, state);
    let window = app.get_window("main").ok_or("main window missing")?;
    let script = injection_script(adapter);
    let url = if let Some(rest) = adapter.url.strip_prefix("app://") {
        WebviewUrl::App(rest.to_string().into())
    } else {
        WebviewUrl::External(
            tauri::Url::parse(&adapter.url).map_err(|e| format!("bad adapter url: {e}"))?,
        )
    };
    let mut builder = WebviewBuilder::new(PROVIDER_LABEL, url)
        .initialization_script(script)
        .focused(false);
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        builder = builder.data_directory(data_dir_for(app, profile_id)?);
    }
    #[cfg(target_os = "macos")]
    {
        builder = builder.data_store_identifier(store_id(profile_id));
    }
    let rect = *state.rect.lock().unwrap();
    let webview = window
        .add_child(
            builder,
            Position::Physical(tauri::PhysicalPosition::new(rect.x, rect.y)),
            Size::Physical(tauri::PhysicalSize::new(rect.w.max(1) as u32, rect.h.max(1) as u32)),
        )
        .map_err(|e| format!("add_child failed: {e}"))?;
    *state.mounted.lock().unwrap() = Some(MountedProfile {
        profile_id: profile_id.to_string(),
        adapter_id: adapter.id.clone(),
    });
    let _ = webview; // kept alive by the manager
    Ok(())
}

pub fn unmount_if_any(app: &tauri::AppHandle, state: &WebviewState) {
    *state.mounted.lock().unwrap() = None;
    if let Some(wv) = app.get_webview(PROVIDER_LABEL) {
        let _ = wv.close();
    }
}

pub fn apply_rect(app: &tauri::AppHandle, state: &WebviewState, rect: Rect) {
    *state.rect.lock().unwrap() = rect;
    if let Some(wv) = app.get_webview(PROVIDER_LABEL) {
        let _ = wv.set_position(Position::Physical(tauri::PhysicalPosition::new(rect.x, rect.y)));
        let _ = wv.set_size(Size::Physical(tauri::PhysicalSize::new(rect.w.max(1) as u32, rect.h.max(1) as u32)));
    }
}

pub fn set_visible(app: &tauri::AppHandle, state: &WebviewState, visible: bool) {
    if let Some(wv) = app.get_webview(PROVIDER_LABEL) {
        if visible {
            let _ = wv.show();
        } else {
            let _ = wv.hide();
        }
    }
    // Remounting after a destroy is done explicitly via ui_providers_login,
    // which knows the full profile -> adapter mapping.
}
