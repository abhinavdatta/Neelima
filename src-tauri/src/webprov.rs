//! Web provider: drives the embedded provider web chat through the adapter
//! runtime. ONE provider webview alive at a time. When the user clicks Chat the
//! webview is HIDDEN (kept alive; the page never reloads mid-conversation) —
//! it is destroyed only on explicit Close, a profile change, or >10 min idle
//! with no running task, and NEVER while an agent task is active. Per-profile
//! isolation: data_directory (Windows/Linux) or data_store_identifier (macOS).
//!
//! Push events (A3): the page posts `ready`, `login_state` and
//! `assistant_message` on its own; Rust stores the latest state in WebviewState
//! and waits with tokio Notify/watch + timeouts. NO polling loops anywhere.
//!
//! Navigation guard (B1): `on_navigation` allows only the adapter's allowed
//! domain + its auth domains; anything else opens in the system browser.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{Emitter, Manager, Position, Size, State, Webview, WebviewUrl, WebviewBuilder};
use tokio::sync::Notify;

use crate::adapters::Adapter;
use crate::bridge::BridgeHub;

pub const PROVIDER_LABEL: &str = "provider";

/// Idle time after which a hidden provider webview may be destroyed.
pub const HIDDEN_IDLE_DESTROY_MS: u64 = 10 * 60 * 1000;

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
    /// Latest page-reported login state (push events; no polling).
    pub login: Mutex<LoginState>,
    /// Set when the page posted `ready` (then cleared by waiters).
    pub ready: Arc<Notify>,
    /// Last assistant message pushed by the page, keyed by seq.
    pub last_message: Mutex<(u64, String)>,
    /// Incremented so waiters know a new message arrived.
    pub message_notify: Arc<Notify>,
    /// TCSO / stream relay: latest streaming text from the page.
    pub stream: Mutex<String>,
    /// When the webview was last hidden (for the idle destroy sweep).
    pub hidden_since: Mutex<Option<Instant>>,
    /// Whether an agent task is currently using this webview.
    pub task_active: Mutex<bool>,
    /// Chat started flag for the current task (A8: new_chat once per task).
    pub chat_started_for: Mutex<Option<String>>,
    /// Last bridge error string, for diagnostics.
    pub last_bridge_error: Mutex<Option<String>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MountedProfile {
    pub profile_id: String,
    pub adapter_id: String,
}

/// Three-state login posture (A4): a bridge failure is NEVER "logged out".
#[derive(Debug, Clone, PartialEq)]
pub enum LoginState {
    Unknown { reason: String, url: String },
    LoggedIn { url: String },
    LoggedOut { url: String },
}

impl Default for LoginState {
    fn default() -> Self {
        LoginState::Unknown { reason: "not mounted yet".into(), url: String::new() }
    }
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
    // The per-mount nonce is passed per-RPC at eval time; the page needs nothing up front.
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

    /// Fire a method call into the page (no per-call response expected).
    /// B2: every call carries the per-mount nonce so pushes that originate in
    /// this conversation stay authenticated.
    fn fire(&self, method: &str, arg: &Value) -> Result<(), String> {
        let wv = self.app.get_webview(PROVIDER_LABEL).ok_or("provider webview is not open")?;
        let nonce = self.hub.current_nonce();
        let js = format!(
            "window.__LB__ && window.__LB__.call({:?}, {:?}, null, {:?})",
            method,
            serde_json::to_string(arg).unwrap_or_else(|_| "{}".into()),
            nonce
        );
        wv.eval(js).map_err(|e| format!("eval failed: {e}"))
    }

    /// A6: wait for the page's `ready` push before any RPC/fire.
    async fn wait_ready(&self, timeout_ms: u64) -> Result<(), String> {
        if self.is_ready_hint() {
            return Ok(());
        }
        let _ = self.app.emit("evt", json!({"kind": "provider-waiting", "what": "page-load", "adapter": self.adapter.name}));
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(format!(
                    "provider page never became ready in {timeout_ms} ms — can't reach {} (bridge unreachable)",
                    self.adapter.name
                ));
            }
            let notified = tokio::select! {
                _ = self.state.ready.notified() => true,
                _ = tokio::time::sleep(left) => false,
            };
            if notified && self.is_ready_hint() {
                return Ok(());
            }
        }
    }

    /// The `ready` push also carries a login_state; treat "unknown with a URL"
    /// as evidence the page is alive. (The canonical ready flag is the Notify.)
    fn is_ready_hint(&self) -> bool {
        match &*self.state.login.lock().unwrap() {
            LoginState::Unknown { url, .. } => !url.is_empty(),
            _ => true,
        }
    }

    /// Read the current login posture from push events (NOT from polling).
    async fn await_login(&self, timeout_secs: u64) -> Result<LoginState, String> {
        let deadline = Instant::now() + Duration::from_secs(timeout_secs);
        loop {
            if Instant::now() > deadline {
                return Err(format!("login wait timed out after {timeout_secs}s"));
            }
            let cur = self.state.login.lock().unwrap().clone();
            match cur {
                LoginState::LoggedIn { .. } => return Ok(cur),
                LoginState::Unknown { reason, .. } => {
                    let _ = self.app.emit("evt", json!({
                        "kind": "provider-login-state",
                        "state": "unknown",
                        "adapter": self.adapter.name,
                        "reason": reason,
                    }));
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
                LoginState::LoggedOut { .. } => {
                    let _ = self.app.emit("evt", json!({
                        "kind": "provider-login-state",
                        "state": "logged_out",
                        "adapter": self.adapter.name,
                    }));
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        }
    }

    pub async fn send(&mut self, task_id: &str, text: &str, first_of_task: bool) -> Result<(), String> {
        if !is_mounted(&self.state, &self.profile_id) {
            mount(&self.app, &self.profile_id, &self.adapter, &self.state).await?;
        }
        let _ = set_visible(&self.app, &self.state, true);

        // A6: never assume the page is up before the first push event.
        self.wait_ready(20_000).await.map_err(|e| {
            let e = set_bridge_err(&self.state.last_bridge_error, e);
            ProviderError::BridgeUnreachable(e).message()
        })?;

        // A4: three states; unknown => "can't reach the page" (diagnose),
        // NOT the login prompt. The UI shows Test connection + the
        // "I'm logged in, continue" override; a retry then succeeds.
        loop {
            let cur = { self.state.login.lock().unwrap().clone() };
            match cur {
                LoginState::LoggedIn { .. } => break,
                LoginState::LoggedOut { .. } => {
                    let _ = self.app.emit("evt", json!({"kind": "provider-login-required", "adapter": self.adapter.name}));
                    match self.await_login(300).await {
                        Ok(_) => break,
                        Err(_) => return Err(ProviderError::NeedsLogin.message()),
                    }
                }
                LoginState::Unknown { reason, .. } => {
                    // Give the page a short settle window (it usually reports
                    // real state within seconds); then degrade cleanly.
                    let settle = Instant::now() + Duration::from_secs(30);
                    let mut known = false;
                    while Instant::now() < settle {
                        tokio::time::sleep(Duration::from_secs(1)).await;
                        if !matches!(
                            &*self.state.login.lock().unwrap(),
                            LoginState::Unknown { .. }
                        ) {
                            known = true;
                            break;
                        }
                    }
                    if !known {
                        let e = set_bridge_err(
                            &self.state.last_bridge_error,
                            format!("page never reported a login state: {reason}"),
                        );
                        let _ = self.app.emit("evt", json!({
                            "kind": "provider-bridge-unreachable",
                            "adapter": self.adapter.name,
                            "reason": reason,
                        }));
                        return Err(ProviderError::BridgeUnreachable(e).message());
                    }
                }
            }
        }

        // A8: new_chat ONLY for the first message of a task (keep a per-task
        // flag; never reset the conversation mid-task).
        let already = self.state.chat_started_for.lock().unwrap().clone();
        if first_of_task && already.as_deref() != Some(task_id) {
            let _ = self.fire("new_chat", &json!(null));
            *self.state.chat_started_for.lock().unwrap() = Some(task_id.to_string());
            // Give the SPA a beat to re-render (bounded; the page re-posts ready).
            tokio::time::sleep(Duration::from_millis(600)).await;
        }

        // send_message is fire-and-forget; the runtime posts assistant_message
        // pushes when the reply completes (wait_reply consumes them).
        let sent = self.fire("send_message", &json!({"text": text, "quiet_ms": self.adapter.quiet_ms}));
        match sent {
            Ok(()) => {}
            Err(e) => {
                let e = set_bridge_err(&self.state.last_bridge_error, e);
                return Err(ProviderError::SendFailed(e).message());
            }
        }
        Ok(())
    }

    /// Wait for the assistant message push (A3). Cancel-safe via Notify.
    pub async fn wait_reply(&mut self, cancel: Arc<Notify>) -> Result<String, String> {
        let timeout = self.adapter.response_timeout_ms as u64;
        let deadline = Instant::now() + Duration::from_millis(timeout);
        let (start_seq, start_text) = self.state.last_message.lock().unwrap().clone();
        let started = !start_text.is_empty();
        loop {
            if Instant::now() > deadline {
                return Err("response timeout waiting for the assistant message".into());
            }
            let left = deadline.saturating_duration_since(Instant::now());
            tokio::select! {
                _ = self.state.message_notify.notified() => {
                    let (seq, text) = self.state.last_message.lock().unwrap().clone();
                    if !text.is_empty() && (seq > start_seq || seq == start_seq && !started) {
                        if text.trim().is_empty() && seq <= start_seq { continue; }
                        return Ok(text);
                    }
                }
                _ = cancel.notified() => return Err("stopped".into()),
                _ = tokio::time::sleep(left.min(Duration::from_millis(500))) => {},
            }
        }
    }
}

impl From<ProviderError> for String {
    fn from(e: ProviderError) -> String {
        e.message()
    }
}

/// A10: typed provider errors so the agent can pick the right fallback.
#[derive(Debug, Clone)]
pub enum ProviderError {
    NeedsLogin,
    BridgeUnreachable(String),
    PageChanged(String),
    Timeout(String),
    SendFailed(String),
}

impl ProviderError {
    pub fn message(&self) -> String {
        match self {
            ProviderError::NeedsLogin => "NEEDS_LOGIN".into(),
            ProviderError::BridgeUnreachable(d) => format!("can't reach the provider page ({d})"),
            ProviderError::PageChanged(d) => format!("provider page changed (selectors may be stale): {d}"),
            ProviderError::Timeout(d) => format!("provider timeout: {d}"),
            ProviderError::SendFailed(d) => format!("send failed: {d}"),
        }
    }
}

fn set_bridge_err(slot: &Mutex<Option<String>>, e: String) -> String {
    *slot.lock().unwrap() = Some(e.clone());
    e
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

/// Push-event intake from bridge.rs.
pub fn on_page_ready(app: &tauri::AppHandle) {
    let st: State<'_, Arc<WebviewState>> = app.state();
    // Notifying wakes any wait_ready waiter; login state arrives separately.
    st.ready.notify_one();
    let _ = app.emit("evt", json!({"kind": "provider-page-ready"}));
}

pub fn on_login_state(webview: &Webview, app: &tauri::AppHandle, state_s: String, url: String, reason: String) {
    let _ = webview;
    let st: State<'_, Arc<WebviewState>> = app.state();
    {
        let mut login = st.login.lock().unwrap();
        *login = match state_s.as_str() {
            "logged_in" => LoginState::LoggedIn { url: url.clone() },
            "logged_out" => LoginState::LoggedOut { url: url.clone() },
            _ => LoginState::Unknown { reason: reason.clone(), url: url.clone() },
        };
    }
    let _ = app.emit(
        "evt",
        json!({"kind": "provider-login-state", "state": state_s, "url": url, "reason": reason}),
    );
    st.ready.notify_one();
}

pub fn on_assistant_message(webview: &Webview, text: String, seq: u64) {
    let _ = webview;
    if let Some(app) = webview.app_handle_or_empty() {
        let st: State<'_, Arc<WebviewState>> = app.state();
        {
            let mut last = st.last_message.lock().unwrap();
            if seq >= last.0 {
                *last = (seq, text.clone());
            }
        }
        st.message_notify.notify_one();
        let _ = app.emit("evt", json!({"kind": "assistant-stream-complete", "len": text.len()}));
    }
}

/// Small helper so tests can compile without a real Webview handle.
trait WebviewHelper {
    fn app_handle_or_empty(&self) -> Option<tauri::AppHandle>;
}

impl WebviewHelper for Webview {
    fn app_handle_or_empty(&self) -> Option<tauri::AppHandle> {
        Some(self.app_handle().clone())
    }
}

/// Create (or re-point) the single provider webview. Destroys a previous one,
/// rotates the bridge nonce, and installs the navigation guard (B1).
pub async fn mount(
    app: &tauri::AppHandle,
    profile_id: &str,
    adapter: &Adapter,
    state: &WebviewState,
) -> Result<(), String> {
    let hub: State<'_, Arc<BridgeHub>> = app.state();
    unmount_if_any(app, state);
    hub.new_nonce();
    // Reset watch state for a fresh page.
    *state.login.lock().unwrap() = LoginState::Unknown { reason: "loading".into(), url: String::new() };
    *state.last_message.lock().unwrap() = (0, String::new());
    *state.chat_started_for.lock().unwrap() = None;
    *state.last_bridge_error.lock().unwrap() = None;
    *state.hidden_since.lock().unwrap() = None;

    let window = app.get_window("main").ok_or("main window missing")?;
    let script = injection_script(adapter);
    let url = if let Some(rest) = adapter.url.strip_prefix("app://") {
        WebviewUrl::App(rest.to_string().into())
    } else {
        WebviewUrl::External(
            tauri::Url::parse(&adapter.url).map_err(|e| format!("bad adapter url: {e}"))?,
        )
    };
    let start_domain = allowed_host(adapter);
    let auth_list = adapter.auth_domains.clone();
    let adapter_name = adapter.name.clone();
    let nav_app = app.clone();
    let mut builder = WebviewBuilder::new(PROVIDER_LABEL, url)
        .initialization_script(script)
        .focused(false)
        .on_navigation(move |url| {
            // B1: only the adapter's own domain + auth domains may load here.
            // Everything else (a malicious link inside the chat, an ad, an
            // OAuth consent page we do not whitelist) opens in the system
            // browser instead. app:// (bundled demo page) is always allowed.
            let s = url.to_string();
            if let Ok(parsed) = tauri::Url::parse(&s) {
                if parsed.scheme() != "http" && parsed.scheme() != "https" {
                    return true;
                }
                let host = parsed.host_str().unwrap_or("").to_string();
                if host.is_empty() {
                    return true;
                }
                if domain_allowed(&host, &start_domain, &auth_list) {
                    return true;
                }
                let _ = open_in_system_browser(&nav_app, &s);
                let _ = nav_app.emit(
                    "evt",
                    json!({"kind": "notify", "level": "warn", "text": format!("Blocked navigation to {host} — opened it in your system browser instead. Only {} and its login pages may load inside the provider pane.", adapter_name)}),
                );
                return false;
            }
            true
        });
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        builder = builder.data_directory(data_dir_for(app, profile_id)?);
    }
    #[cfg(target_os = "macos")]
    {
        builder = builder.data_store_identifier(store_id(profile_id));
    }
    let mut rect = *state.rect.lock().unwrap();
    // Guard against geometry reported before the pane ever rendered.
    if rect.w <= 1 || rect.h <= 1 {
        if let Ok(sz) = window.inner_size() {
            let dpr = window.scale_factor().unwrap_or(1.0);
            let w = (sz.width as f64 / dpr).max(400.0) as i32;
            let h = (sz.height as f64 / dpr - 120.0).max(300.0) as i32;
            rect = Rect { x: 272, y: 46, w, h };
        }
    }
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
    let _ = app.emit(
        "evt",
        serde_json::json!({"kind": "provider-mounted", "profile": profile_id, "adapter": adapter.id}),
    );
    Ok(())
}

/// B1: public host extractor for URLs (used when saving user-built adapters).
pub fn host_of(url: &str) -> String {
    if url.starts_with("app://") {
        return String::new();
    }
    tauri::Url::parse(url).ok().and_then(|u| u.host_str().map(|h| h.to_string())).unwrap_or_default()
}

/// Extract the host of the adapter start URL. app:// pages are always trusted.
fn allowed_host(adapter: &Adapter) -> String {
    if adapter.url.starts_with("app://") {
        return String::new();
    }
    tauri::Url::parse(&adapter.url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_default()
}

fn domain_allowed(host: &str, start: &str, auth: &[String]) -> bool {
    if host.eq_ignore_ascii_case(start) {
        return true;
    }
    // Subdomains of the start domain are allowed (login flows bounce through sso).
    if !start.is_empty() && host.ends_with(&format!(".{start}")) {
        return true;
    }
    auth.iter().any(|a| {
        let a = a.trim().trim_start_matches('.');
        host.eq_ignore_ascii_case(a) || host.ends_with(&format!(".{a}"))
    })
}

pub fn unmount_if_any(app: &tauri::AppHandle, state: &WebviewState) {
    let had = state.mounted.lock().unwrap().take();
    if let Some(wv) = app.get_webview(PROVIDER_LABEL) {
        let _ = wv.close();
    }
    *state.hidden_since.lock().unwrap() = None;
    if had.is_some() {
        let _ = app.emit("evt", serde_json::json!({"kind": "provider-unmounted"}));
    }
}

/// A7: hide the webview (do NOT destroy) so the page never reloads when the
/// user clicks Chat. Destroying only happens via explicit close/idle sweep.
pub fn hide_if_any(app: &tauri::AppHandle, state: &WebviewState) {
    if let Some(wv) = app.get_webview(PROVIDER_LABEL) {
        let _ = wv.hide();
        *state.hidden_since.lock().unwrap() = Some(Instant::now());
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
            *state.hidden_since.lock().unwrap() = None;
        } else {
            hide_if_any(app, state);
        }
    }
}

/// Destroy the webview only when it is safe: never while an agent task runs,
/// and only past the idle window (or immediately when the user asked).
pub fn destroy_if_idle(app: &tauri::AppHandle, state: &WebviewState, force: bool) -> bool {
    let task_active = *state.task_active.lock().unwrap();
    if task_active && !force {
        return false;
    }
    let hidden = *state.hidden_since.lock().unwrap();
    if !force {
        match hidden {
            Some(t) if t.elapsed() >= Duration::from_millis(HIDDEN_IDLE_DESTROY_MS) => {}
            _ => return false,
        }
    }
    unmount_if_any(app, state);
    true
}

pub fn open_in_system_browser(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    // No plugin needed: shell-open via `start`/`open`/`xdg-open`.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(url).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(url).spawn().map_err(|e| e.to_string())?;
    }
    let _ = app.emit("evt", json!({"kind": "notify", "text": format!("Opened {url} in your system browser.")}));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// B1: only adapter + auth domains survive the navigation guard.
    #[test]
    fn nav_guard_domains() {
        let allowed = domain_allowed("claude.ai", "claude.ai", &[]);
        assert!(allowed);
        assert!(domain_allowed("sso.claude.ai", "claude.ai", &[]));
        assert!(!domain_allowed("evil.com", "claude.ai", &[]));
        assert!(domain_allowed("accounts.google.com", "gemini.google.com", &["accounts.google.com".into(), "accounts.youtube.com".into()]));
        assert!(domain_allowed("login.microsoftonline.com", "chatgpt.com", &["auth0.com".into(), "login.microsoftonline.com".into()]));
        assert!(!domain_allowed("tracker.example", "", &["auth0.com".into()]));
    }

    /// A4: a bridge failure must never classify as logged out.
    #[test]
    fn unknown_is_not_loggedout() {
        let a = LoginState::Unknown { reason: "bridge timeout".into(), url: "https://x".into() };
        assert_ne!(a, LoginState::LoggedOut { url: "https://x".into() });
    }

    /// A2: the page's ONLY allowed message types never include file ops.
    #[test]
    fn no_file_ops_in_bridge() {
        let s = crate::bridge::ALLOWED_TYPES.join(",");
        assert!(!s.contains("file_op"), "file_op must not exist anymore");
        assert!(!s.contains("read_file"));
        assert!(!s.contains("write_file"));
        assert!(!s.contains("list_dir"));
    }

    /// A7: idle destroy never fires while a task is active.
    #[test]
    fn destroy_blocked_while_task_active() {
        let st = WebviewState::default();
        *st.task_active.lock().unwrap() = true;
        *st.hidden_since.lock().unwrap() = Some(Instant::now() - Duration::from_secs(60 * 30));
        assert!(!destroy_if_idle_sim(&st, false));
        *st.task_active.lock().unwrap() = false;
        assert!(destroy_if_idle_sim(&st, false));
    }

    fn destroy_if_idle_sim(state: &WebviewState, force: bool) -> bool {
        let task_active = *state.task_active.lock().unwrap();
        if task_active && !force {
            return false;
        }
        let hidden = *state.hidden_since.lock().unwrap();
        if !force {
            match hidden {
                Some(t) if t.elapsed() >= Duration::from_millis(HIDDEN_IDLE_DESTROY_MS) => {}
                _ => return false,
            }
        }
        true
    }
}
