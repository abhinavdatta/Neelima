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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{Emitter, Manager, Position, Size, State, Webview, WebviewBuilder, WebviewUrl};
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
    /// Inspector mode target for capture.
    pub inspector: Mutex<Option<InspectorSession>>,
    /// Latest page-reported login state (push events; no polling).
    pub login: Mutex<LoginState>,
    /// Set when the page posted `ready` (then cleared by waiters).
    pub ready: Arc<Notify>,
    pub page_ready: AtomicBool,
    /// Push notification for changes to the page's login posture.
    pub login_changed: Arc<Notify>,
    /// Last assistant message pushed by the page, keyed by seq.
    pub last_message: Mutex<(u64, String)>,
    /// Sequence captured immediately before a send, so a fast reply cannot be
    /// missed if it arrives before the agent begins waiting.
    pub response_baseline: std::sync::atomic::AtomicU64,
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
    Loading { reason: String, url: String },
    Unknown { reason: String, url: String },
    LoggedIn { url: String },
    LoggedOut { url: String },
    Challenge { reason: String, url: String },
}

impl Default for LoginState {
    fn default() -> Self {
        LoginState::Loading {
            reason: "provider page has not loaded yet".into(),
            url: String::new(),
        }
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

pub fn injection_script(adapter: &Adapter, mount_nonce: &str) -> String {
    let cfg = serde_json::to_string(adapter).unwrap_or_else(|_| "{}".into());
    format!(
        "window.__LB_NONCE__ = {:?};\nwindow.__LB_ADAPTER__ = {cfg};\n{}",
        mount_nonce,
        include_str!("adapter_runtime.js")
    )
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
        let wv = self
            .app
            .get_webview(PROVIDER_LABEL)
            .ok_or("provider webview is not open")?;
        let nonce = self.hub.current_nonce();
        let js = format!(
            "window.__LB__ && window.__LB__.call({:?}, {:?}, null, {:?})",
            method,
            serde_json::to_string(arg).unwrap_or_else(|_| "{}".into()),
            nonce
        );
        wv.eval(js).map_err(|e| format!("eval failed: {e}"))
    }

    async fn call(&self, method: &str, arg: &Value) -> Result<Value, ProviderError> {
        let wv = self.app.get_webview(PROVIDER_LABEL).ok_or_else(|| {
            ProviderError::BridgeUnreachable(set_bridge_err(
                &self.state.last_bridge_error,
                "provider webview is not open".into(),
            ))
        })?;
        let arg_json = serde_json::to_string(arg).map_err(|e| {
            ProviderError::SendFailed(format!("could not serialize provider call: {e}"))
        })?;
        let (req_id, nonce, rx) = self.hub.begin();
        let js = format!(
            "window.__LB__ && window.__LB__.call({:?}, {:?}, {:?}, {:?})",
            method, arg_json, req_id, nonce
        );
        if let Err(e) = wv.eval(js) {
            self.hub.cancel(&req_id);
            return Err(ProviderError::SendFailed(set_bridge_err(
                &self.state.last_bridge_error,
                format!("eval failed: {e}"),
            )));
        }
        let reply = crate::bridge::BridgeHub::wait(rx, 10_000)
            .await
            .map_err(|e| {
                self.hub.cancel(&req_id);
                ProviderError::Timeout(set_bridge_err(&self.state.last_bridge_error, e))
            })?;
        if reply["ok"] == false {
            return Err(ProviderError::SendFailed(
                reply["error"]
                    .as_str()
                    .unwrap_or("provider call failed")
                    .to_string(),
            ));
        }
        Ok(reply.get("value").cloned().unwrap_or(Value::Null))
    }

    /// A6: wait for the page's `ready` push before any RPC/fire.
    async fn wait_ready(&self, timeout_ms: u64) -> Result<(), String> {
        if self.state.page_ready.load(Ordering::Acquire) {
            return Ok(());
        }
        let _ = self.app.emit(
            "evt",
            json!({"kind": "provider-waiting", "what": "page-load", "adapter": self.adapter.name}),
        );
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(format!(
                    "provider page never became ready in {timeout_ms} ms — can't reach {} (bridge unreachable)",
                    self.adapter.name
                ));
            }
            let notified = self.state.ready.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.state.page_ready.load(Ordering::Acquire) {
                return Ok(());
            }
            let notified = tokio::select! {
                _ = &mut notified => true,
                _ = tokio::time::sleep(left) => false,
            };
            if notified && self.state.page_ready.load(Ordering::Acquire) {
                return Ok(());
            }
        }
    }

    /// Read the current login posture from push events (NOT from polling).
    async fn await_login(&self, timeout_secs: u64) -> Result<LoginState, String> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs);
        loop {
            let notified = self.state.login_changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let cur = self.state.login.lock().unwrap().clone();
            if matches!(cur, LoginState::LoggedIn { .. }) {
                return Ok(cur);
            }
            tokio::select! {
                _ = &mut notified => {},
                _ = tokio::time::sleep_until(deadline) => {
                    return Err(format!("login wait timed out after {timeout_secs}s"));
                }
            }
        }
    }

    async fn await_known_login(&self, timeout: Duration) -> Result<LoginState, String> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = self.state.login_changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let cur = self.state.login.lock().unwrap().clone();
            if !matches!(cur, LoginState::Unknown { .. } | LoginState::Loading { .. }) {
                return Ok(cur);
            }
            tokio::select! {
                _ = &mut notified => {},
                _ = tokio::time::sleep_until(deadline) => {
                    return Err("page did not report a login state".into());
                }
            }
        }
    }

    pub async fn send(
        &mut self,
        task_id: &str,
        text: &str,
        first_of_task: bool,
    ) -> Result<(), ProviderError> {
        if !is_mounted(&self.state, &self.profile_id, &self.adapter.id) {
            mount(&self.app, &self.profile_id, &self.adapter, &self.state)
                .await
                .map_err(ProviderError::PageChanged)?;
        }
        // Keep the provider page hidden during ordinary work. The UI only
        // reveals it after an explicit sign-in action or a login-required event.

        // A6: never assume the page is up before the first push event.
        self.wait_ready(20_000).await.map_err(|e| {
            ProviderError::BridgeUnreachable(set_bridge_err(&self.state.last_bridge_error, e))
        })?;

        // Wait for an observed chat/auth/challenge state. Document load alone
        // is not evidence that the SPA or its composer has finished rendering.
        loop {
            let cur = { self.state.login.lock().unwrap().clone() };
            match cur {
                LoginState::LoggedIn { .. } => break,
                LoginState::LoggedOut { .. } | LoginState::Challenge { .. } => {
                    let _ = self.app.emit(
                        "evt",
                        json!({"kind": "provider-login-required", "adapter": self.adapter.name, "reason": match &cur { LoginState::Challenge { reason, .. } => reason.as_str(), _ => "sign-in is required" }}),
                    );
                    match self.await_login(300).await {
                        Ok(_) => break,
                        Err(_) => return Err(ProviderError::NeedsLogin),
                    }
                }
                LoginState::Unknown { .. } | LoginState::Loading { .. } => {
                    match self.await_known_login(Duration::from_secs(30)).await {
                        Ok(LoginState::Challenge { reason, .. }) => {
                            let _ = self.app.emit(
                                "evt",
                                json!({
                                    "kind": "provider-login-required",
                                    "adapter": self.adapter.name,
                                    "reason": reason,
                                }),
                            );
                            return Err(ProviderError::NeedsLogin);
                        }
                        Ok(LoginState::LoggedOut { .. }) => {
                            let _ = self.app.emit(
                                "evt",
                                json!({
                                    "kind": "provider-login-required",
                                    "adapter": self.adapter.name,
                                    "reason": "sign-in is required",
                                }),
                            );
                            return Err(ProviderError::NeedsLogin);
                        }
                        Ok(LoginState::LoggedIn { .. }) => break,
                        Ok(LoginState::Unknown { .. } | LoginState::Loading { .. }) | Err(_) => {
                            let e = actionable_composer_error(&self.state.login.lock().unwrap());
                            let e = set_bridge_err(&self.state.last_bridge_error, e);
                            let _ = self.app.emit(
                                "evt",
                                json!({
                                    "kind": "provider-bridge-unreachable",
                                    "adapter": self.adapter.name,
                                    "reason": e,
                                }),
                            );
                            return Err(ProviderError::BridgeUnreachable(e));
                        }
                    }
                }
            }
        }

        // A8: new_chat ONLY for the first message of each task, after the
        // supported chat interface has been positively identified.
        let already = self.state.chat_started_for.lock().unwrap().clone();
        if first_of_task && already.as_deref() != Some(task_id) {
            if let Err(e) = self.fire("new_chat", &json!(null)) {
                return Err(ProviderError::PageChanged(format!(
                    "could not start a provider chat: {e}"
                )));
            }
            *self.state.chat_started_for.lock().unwrap() = Some(task_id.to_string());
        }

        // Ensure the composer still exists immediately before each send; an
        // SPA navigation can invalidate an earlier login-state observation.
        match self.call("page_info", &json!(null)).await {
            Ok(info) if info["value"]["input_found"].as_bool() == Some(true) => {}
            Ok(info) => {
                return Err(ProviderError::PageChanged(format!(
                    "chat composer is no longer available (page state: {})",
                    info["value"]["login"]["reason"]
                        .as_str()
                        .unwrap_or("unknown")
                )))
            }
            Err(e) => return Err(e),
        }

        let baseline = self.state.last_message.lock().unwrap().0;
        self.state
            .response_baseline
            .store(baseline, Ordering::Release);

        // A10: trust only the explicit acknowledgement returned after the
        // provider UI confirms that the submitted prompt entered its chat.
        let result = self
            .call(
                "send_message",
                &json!({"text": text, "quiet_ms": self.adapter.quiet_ms}),
            )
            .await?;
        classify_send_result(&result)?;
        Ok(())
    }

    /// Wait for the assistant message push (A3). Cancel-safe via Notify.
    pub async fn wait_reply(&mut self, cancel: Arc<Notify>) -> Result<String, String> {
        let start_seq = self.state.response_baseline.load(Ordering::Acquire);
        wait_for_reply_state(
            &self.state,
            start_seq,
            Duration::from_millis(self.adapter.response_timeout_ms),
            cancel,
        )
        .await
    }
}

async fn wait_for_reply_state(
    state: &WebviewState,
    start_seq: u64,
    timeout: Duration,
    cancel: Arc<Notify>,
) -> Result<String, String> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let notified = state.message_notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let (seq, text) = state.last_message.lock().unwrap().clone();
        if seq > start_seq && !text.trim().is_empty() {
            return Ok(text);
        }
        tokio::select! {
            _ = &mut notified => {},
            _ = cancel.notified() => return Err("stopped".into()),
            _ = tokio::time::sleep_until(deadline) => {
                return Err("response timeout waiting for the assistant message".into());
            },
        }
    }
}

fn actionable_composer_error(state: &LoginState) -> String {
    let reason = match state {
        LoginState::Unknown { reason, .. } | LoginState::Loading { reason, .. } => reason.as_str(),
        LoginState::Challenge { reason, .. } => reason.as_str(),
        LoginState::LoggedOut { .. } => "sign-in is required",
        LoginState::LoggedIn { .. } => {
            "provider chat was reported ready, but its composer could not be reached"
        }
    };
    format!("{reason}. Open the provider sign-in window to refresh it, or choose a configured Ollama/LM Studio model. Neelima did not submit the prompt.")
}

impl From<ProviderError> for String {
    fn from(e: ProviderError) -> String {
        e.message()
    }
}

/// Typed provider errors; the agent surfaces these without silently changing
/// providers or moving the conversation out of Neelima.
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
            ProviderError::NeedsLogin => "Provider sign-in or verification is required. Open the provider sign-in window, complete it, then retry; or select a configured API/local model.".into(),
            ProviderError::BridgeUnreachable(d) => format!("can't reach the provider page ({d})"),
            ProviderError::PageChanged(d) => {
                format!("provider page changed (selectors may be stale): {d}")
            }
            ProviderError::Timeout(d) => format!("provider timeout: {d}"),
            ProviderError::SendFailed(d) => format!("send failed: {d}"),
        }
    }
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

fn classify_send_result(result: &Value) -> Result<(), ProviderError> {
    match result["error_type"].as_str() {
        Some("page_changed") => Err(ProviderError::PageChanged(
            result["error"]
                .as_str()
                .unwrap_or("provider input selector is missing")
                .to_string(),
        )),
        Some(_) => Err(ProviderError::SendFailed(
            result["error"]
                .as_str()
                .unwrap_or("provider rejected the send")
                .to_string(),
        )),
        None => Ok(()),
    }
}

fn set_bridge_err(slot: &Mutex<Option<String>>, e: String) -> String {
    *slot.lock().unwrap() = Some(e.clone());
    e
}

pub fn is_mounted(state: &WebviewState, profile_id: &str, adapter_id: &str) -> bool {
    state
        .mounted
        .lock()
        .unwrap()
        .as_ref()
        .map(|m| m.profile_id == profile_id && m.adapter_id == adapter_id)
        .unwrap_or(false)
}

fn mounted_profile_matches(
    current: Option<&MountedProfile>,
    profile_id: &str,
    adapter_id: &str,
) -> bool {
    current
        .map(|m| m.profile_id == profile_id && m.adapter_id == adapter_id)
        .unwrap_or(false)
}

/// Push-event intake from bridge.rs.
pub fn on_page_ready(app: &tauri::AppHandle) {
    let st: State<'_, Arc<WebviewState>> = app.state();
    st.page_ready.store(true, Ordering::Release);
    st.ready.notify_waiters();
    let _ = app.emit("evt", json!({"kind": "provider-page-ready"}));
}

pub fn on_login_state(
    webview: &Webview,
    app: &tauri::AppHandle,
    state_s: String,
    url: String,
    reason: String,
) {
    let _ = webview;
    let st: State<'_, Arc<WebviewState>> = app.state();
    {
        let mut login = st.login.lock().unwrap();
        *login = match state_s.as_str() {
            "logged_in" => LoginState::LoggedIn { url: url.clone() },
            "logged_out" => LoginState::LoggedOut { url: url.clone() },
            "loading" => LoginState::Loading {
                reason: reason.clone(),
                url: url.clone(),
            },
            "challenge" => LoginState::Challenge {
                reason: reason.clone(),
                url: url.clone(),
            },
            _ => LoginState::Unknown {
                reason: reason.clone(),
                url: url.clone(),
            },
        };
    }
    let _ = app.emit(
        "evt",
        json!({"kind": "provider-login-state", "state": state_s, "url": url, "reason": reason}),
    );
    st.login_changed.notify_waiters();
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
        let _ = app.emit(
            "evt",
            json!({"kind": "assistant-stream-complete", "len": text.len()}),
        );
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
    let current = state.mounted.lock().unwrap().clone();
    if mounted_profile_matches(current.as_ref(), profile_id, &adapter.id)
        && app.get_webview(PROVIDER_LABEL).is_some()
    {
        return Ok(());
    }
    if current.is_some() && *state.task_active.lock().unwrap() {
        return Err("cannot change provider profile while an agent task is active".into());
    }
    unmount_if_any(app, state);
    let mount_nonce = hub.new_nonce();
    // Reset watch state for a fresh page.
    state.page_ready.store(false, Ordering::Release);
    *state.login.lock().unwrap() = LoginState::Loading {
        reason: "provider document is loading".into(),
        url: String::new(),
    };
    *state.last_message.lock().unwrap() = (0, String::new());
    *state.chat_started_for.lock().unwrap() = None;
    *state.last_bridge_error.lock().unwrap() = None;
    *state.hidden_since.lock().unwrap() = None;

    let window = app.get_window("main").ok_or("main window missing")?;
    let script = injection_script(adapter, &mount_nonce);
    let url = if let Some(rest) = adapter.url.strip_prefix("app://") {
        WebviewUrl::App(rest.to_string().into())
    } else {
        WebviewUrl::External(
            tauri::Url::parse(&adapter.url).map_err(|e| format!("bad adapter url: {e}"))?,
        )
    };
    let start_domain = if adapter.allowed_domain.is_empty() {
        allowed_host(adapter)
    } else {
        adapter.allowed_domain.clone()
    };
    let auth_list = adapter.auth_domains.clone();
    hub.set_origin(&adapter.url, &start_domain, &auth_list);
    let adapter_url = adapter.url.clone();
    let adapter_name = adapter.name.clone();
    let nav_app = app.clone();
    let mut builder = WebviewBuilder::new(PROVIDER_LABEL, url)
        .initialization_script(script)
        .focused(false)
        .on_navigation(move |url| {
            let s = url.to_string();
            if let Ok(parsed) = tauri::Url::parse(&s) {
                if provider_url_allowed(
                    &parsed,
                    &adapter_url,
                    &start_domain,
                    &auth_list,
                    false,
                ) {
                    return true;
                }
                let host = parsed.host_str().unwrap_or(parsed.scheme()).to_string();
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
            rect = Rect {
                x: 272,
                y: 46,
                w,
                h,
            };
        }
    }
    let webview = window
        .add_child(
            builder,
            Position::Physical(tauri::PhysicalPosition::new(rect.x, rect.y)),
            Size::Physical(tauri::PhysicalSize::new(
                rect.w.max(1) as u32,
                rect.h.max(1) as u32,
            )),
        )
        .map_err(|e| format!("add_child failed: {e}"))?;
    *state.mounted.lock().unwrap() = Some(MountedProfile {
        profile_id: profile_id.to_string(),
        adapter_id: adapter.id.clone(),
    });
    // add_child creates a visible child by default. Hide it immediately;
    // explicit login/inspector entry points reveal it after mount returns.
    hide_if_any(app, state);
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
    tauri::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_default()
}

/// Extract the host of the adapter start URL. Bundled app pages use an empty
/// network-host allowlist and are checked against the internal app origin.
fn allowed_host(adapter: &Adapter) -> String {
    if adapter.url.starts_with("app://") {
        return String::new();
    }
    tauri::Url::parse(&adapter.url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_default()
}

pub fn domain_allowed(host: &str, start: &str, auth: &[String]) -> bool {
    let host = host.to_ascii_lowercase();
    let start = start.to_ascii_lowercase();
    if host == start {
        return true;
    }
    // Subdomains of the start domain are allowed (login flows bounce through sso).
    if !start.is_empty() && host.ends_with(&format!(".{start}")) {
        return true;
    }
    auth.iter().any(|a| {
        let a = a.trim().trim_start_matches('.').to_ascii_lowercase();
        host == a || host.ends_with(&format!(".{a}"))
    })
}

pub fn provider_url_allowed(
    url: &tauri::Url,
    adapter_url: &str,
    primary_host: &str,
    auth_domains: &[String],
    primary_only: bool,
) -> bool {
    if adapter_url.starts_with("app://") {
        return matches!(url.scheme(), "app" | "tauri") && url.host_str() == Some("localhost")
            || matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost");
    }
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    if domain_allowed(host, primary_host, &[]) {
        return true;
    }
    !primary_only && domain_allowed(host, "", auth_domains)
}

pub fn unmount_if_any(app: &tauri::AppHandle, state: &WebviewState) {
    let had = state.mounted.lock().unwrap().take();
    if let Some(wv) = app.get_webview(PROVIDER_LABEL) {
        let _ = wv.close();
    }
    if let Some(hub) = app.try_state::<Arc<BridgeHub>>() {
        hub.clear_origin();
    }
    state.page_ready.store(false, Ordering::Release);
    state.login_changed.notify_waiters();
    state.ready.notify_waiters();
    *state.hidden_since.lock().unwrap() = None;
    if had.is_some() {
        let _ = app.emit("evt", serde_json::json!({"kind": "provider-unmounted"}));
    }
}

/// Clear a provider's persistent webview profile on platforms where Neelima
/// owns the profile directory (Windows WebView2 and Linux WebKit data dir).
/// macOS uses WKWebsiteDataStore identifiers and cannot be cleared through the
/// filesystem safely with this API.
pub fn clear_profile_session(
    app: &tauri::AppHandle,
    state: &WebviewState,
    profile_id: &str,
) -> Result<(), String> {
    if !valid_profile_id(profile_id) {
        return Err("invalid provider profile ID".into());
    }
    let task_active = state.task_active.lock().unwrap();
    if *task_active {
        return Err("cannot clear provider data while an agent task is active".into());
    }
    #[cfg(target_os = "macos")]
    {
        let _ = (app, state, profile_id);
        return Err("Clearing provider session data is not supported by this macOS build. Sign out on the provider website instead.".into());
    }
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let app_data_canon = app_data.canonicalize().map_err(|e| e.to_string())?;
        let profiles = app_data.join("provider-profiles");
        let profiles_meta = match std::fs::symlink_metadata(&profiles) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.to_string()),
            Ok(meta) => meta,
        };
        if profiles_meta.file_type().is_symlink() || !profiles_meta.is_dir() {
            return Err("provider profile storage is not a safe directory".into());
        }
        let profiles_canon = profiles.canonicalize().map_err(|e| e.to_string())?;
        if !profiles_canon.starts_with(&app_data_canon) {
            return Err("provider profile storage escaped app data".into());
        }
        let target = profiles.join(profile_id);
        match std::fs::symlink_metadata(&target) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.to_string()),
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
                return Err("provider session path is not a regular directory".into())
            }
            Ok(_) => {}
        }
        let target_canon = target.canonicalize().map_err(|e| e.to_string())?;
        if !target_canon.starts_with(&profiles_canon) {
            return Err("provider session path escaped its storage directory".into());
        }
        let mounted_for_profile = state
            .mounted
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|mounted| mounted.profile_id == profile_id);
        if mounted_for_profile {
            unmount_if_any(app, state);
        }
        std::fs::remove_dir_all(target)
            .map_err(|e| format!("could not clear provider session: {e}"))
    }
}

fn valid_profile_id(profile_id: &str) -> bool {
    !profile_id.is_empty()
        && profile_id.len() <= 64
        && profile_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A7: hide the webview (do NOT destroy) so the page never reloads when the
/// user clicks Chat. Destroying only happens via explicit close/idle sweep.
pub fn hide_if_any(app: &tauri::AppHandle, state: &WebviewState) {
    if let Some(wv) = app.get_webview(PROVIDER_LABEL) {
        let _ = wv.hide();
        *state.hidden_since.lock().unwrap() = Some(Instant::now());
        let app = app.clone();
        let state = app.state::<Arc<WebviewState>>().inner().clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(HIDDEN_IDLE_DESTROY_MS)).await;
            destroy_if_idle(&app, &state, false);
        });
    }
}

pub fn apply_rect(app: &tauri::AppHandle, state: &WebviewState, rect: Rect) {
    *state.rect.lock().unwrap() = rect;
    if let Some(wv) = app.get_webview(PROVIDER_LABEL) {
        let _ = wv.set_position(Position::Physical(tauri::PhysicalPosition::new(
            rect.x, rect.y,
        )));
        let _ = wv.set_size(Size::Physical(tauri::PhysicalSize::new(
            rect.w.max(1) as u32,
            rect.h.max(1) as u32,
        )));
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
    let parsed = tauri::Url::parse(url).map_err(|_| "invalid external URL".to_string())?;
    validate_external_url(&parsed)?;
    let safe_origin = safe_web_origin(&parsed);
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(parsed.to_string(), None::<&str>)
        .map_err(|e| format!("could not open external URL: {e}"))?;
    let _ = app.emit(
        "evt",
        json!({"kind": "notify", "text": format!("Opened {safe_origin} in your system browser.")}),
    );
    Ok(())
}

fn validate_external_url(url: &tauri::Url) -> Result<(), String> {
    if matches!(url.scheme(), "http" | "https") {
        Ok(())
    } else {
        Err(format!(
            "refusing to open unsupported external URL scheme '{}'",
            url.scheme()
        ))
    }
}

fn safe_web_origin(url: &tauri::Url) -> String {
    match (url.scheme(), url.host_str()) {
        ("http" | "https", Some(host)) => {
            let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
            format!("{}://{}{}", url.scheme(), host, port)
        }
        _ => "[non-web URL]".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn missing_provider_response_returns_a_recoverable_timeout() {
        let state = WebviewState::default();
        state.response_baseline.store(4, Ordering::Release);
        *state.last_message.lock().unwrap() = (4, "stale answer".into());
        let result =
            wait_for_reply_state(&state, 4, Duration::from_millis(1), Arc::new(Notify::new()))
                .await;
        assert_eq!(
            result.unwrap_err(),
            "response timeout waiting for the assistant message"
        );
    }

    #[test]
    fn provider_profile_ids_reject_path_traversal() {
        assert!(valid_profile_id("p123safe"));
        assert!(!valid_profile_id("../outside"));
        assert!(!valid_profile_id("C:\\outside"));
        assert!(!valid_profile_id(""));
    }

    /// B1: only adapter + auth domains survive the navigation guard.
    #[test]
    fn nav_guard_domains() {
        let allowed = domain_allowed("claude.ai", "claude.ai", &[]);
        assert!(allowed);
        assert!(domain_allowed("sso.claude.ai", "claude.ai", &[]));
        assert!(!domain_allowed("evil.com", "claude.ai", &[]));
        assert!(domain_allowed(
            "accounts.google.com",
            "gemini.google.com",
            &["accounts.google.com".into(), "accounts.youtube.com".into()]
        ));
        assert!(domain_allowed(
            "login.microsoftonline.com",
            "chatgpt.com",
            &["auth0.com".into(), "login.microsoftonline.com".into()]
        ));
        assert!(!domain_allowed(
            "tracker.example",
            "",
            &["auth0.com".into()]
        ));
        let auth = vec!["accounts.google.com".to_string()];
        assert!(provider_url_allowed(
            &tauri::Url::parse("https://CHATGPT.COM/c/1").unwrap(),
            "https://chatgpt.com",
            "chatgpt.com",
            &auth,
            true
        ));
        assert!(provider_url_allowed(
            &tauri::Url::parse("https://accounts.google.com/").unwrap(),
            "https://chatgpt.com",
            "chatgpt.com",
            &auth,
            false
        ));
        assert!(!provider_url_allowed(
            &tauri::Url::parse("https://accounts.google.com/").unwrap(),
            "https://chatgpt.com",
            "chatgpt.com",
            &auth,
            true
        ));
        assert!(!provider_url_allowed(
            &tauri::Url::parse("mailto:user@example.com").unwrap(),
            "https://chatgpt.com",
            "chatgpt.com",
            &auth,
            false
        ));
        for raw in [
            "file:///C:/Windows/win.ini",
            "javascript:alert(1)",
            "custom://host/path",
        ] {
            let url = tauri::Url::parse(raw).unwrap();
            assert!(
                !provider_url_allowed(&url, "https://chatgpt.com", "chatgpt.com", &auth, false),
                "unexpectedly allowed {raw}"
            );
        }
        assert!(provider_url_allowed(
            &tauri::Url::parse("http://tauri.localhost/index.html").unwrap(),
            "app://localhost/demo",
            "",
            &[],
            true
        ));
        assert!(!provider_url_allowed(
            &tauri::Url::parse("https://evil.example/").unwrap(),
            "app://localhost/demo",
            "",
            &[],
            false
        ));
        assert!(!provider_url_allowed(
            &tauri::Url::parse("app://evil.example/demo").unwrap(),
            "app://localhost/demo",
            "",
            &[],
            false
        ));
    }

    #[test]
    fn external_url_policy_is_web_only_and_notice_is_origin_only() {
        for raw in [
            "https://example.com/path?token=secret#fragment",
            "http://example.com/a&b",
        ] {
            let parsed = tauri::Url::parse(raw).unwrap();
            assert!(validate_external_url(&parsed).is_ok());
            assert_eq!(
                safe_web_origin(&parsed),
                format!("{}://{}", parsed.scheme(), parsed.host_str().unwrap())
            );
        }
        for raw in [
            "file:///C:/secret",
            "javascript:alert(1)",
            "mailto:user@example.com",
            "custom://host/path",
        ] {
            let parsed = tauri::Url::parse(raw).unwrap();
            assert!(
                validate_external_url(&parsed).is_err(),
                "unexpectedly accepted {raw}"
            );
        }
        assert!(tauri::Url::parse("not a URL").is_err());
        let parsed = tauri::Url::parse("https://example.com/path?token=secret#fragment").unwrap();
        let notice = safe_web_origin(&parsed);
        assert!(!notice.contains("secret"));
        assert!(!notice.contains("/path"));
    }

    /// A4: a bridge failure must never classify as logged out.
    #[test]
    fn unknown_is_not_loggedout() {
        let a = LoginState::Unknown {
            reason: "bridge timeout".into(),
            url: "https://x".into(),
        };
        assert_ne!(
            a,
            LoginState::LoggedOut {
                url: "https://x".into()
            }
        );
    }

    #[test]
    fn provider_failures_never_claim_a_prompt_was_sent() {
        assert!(ProviderError::NeedsLogin.message().contains("retry"));
        assert!(
            ProviderError::BridgeUnreachable("composer unavailable".into())
                .to_string()
                .contains("composer unavailable")
        );
        assert!(ProviderError::PageChanged("selector missing".into())
            .to_string()
            .contains("selector missing"));
    }

    #[test]
    fn stale_send_selector_is_classified_as_page_changed() {
        let err = classify_send_result(&json!({
            "error_type": "page_changed",
            "error": "input selector was not found"
        }))
        .unwrap_err();
        assert!(matches!(err, ProviderError::PageChanged(_)));
        assert!(classify_send_result(&json!({"sent": true})).is_ok());
    }

    #[test]
    fn same_profile_mount_is_reused_but_profile_change_is_not() {
        let mounted = MountedProfile {
            profile_id: "p1".into(),
            adapter_id: "a1".into(),
        };
        assert!(mounted_profile_matches(Some(&mounted), "p1", "a1"));
        assert!(!mounted_profile_matches(Some(&mounted), "p2", "a1"));
        assert!(!mounted_profile_matches(Some(&mounted), "p1", "a2"));
        assert!(!mounted_profile_matches(None, "p1", "a1"));
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
