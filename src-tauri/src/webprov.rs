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

/// Default RPC budget for quick page calls (ping, page_info, new_chat).
pub const CALL_TIMEOUT_MS: u64 = 10_000;
/// Budget for `send_message`. The page-side worst case is
/// `waitForSendButton(3000) + waitSubmission(8000)` ≈ 11 s and always resolves;
/// this budget must EXCEED it so the RPC is never cancelled mid-submission
/// (a cancelled send is an unknown outcome that must not be retried).
pub const SEND_CALL_TIMEOUT_MS: u64 = 25_000;
/// After an unconfirmed submission the prompt may or may not have entered the
/// conversation. Wait a bounded time for a reply push instead of the full
/// provider timeout, so an unknown outcome is reported promptly and honestly.
pub const UNCONFIRMED_REPLY_WAIT_MS: u64 = 90_000;

// Response-contract lifecycle states, the terminal guard and the transition
// table live in `crate::request` — the canonical, provider-independent model
// shared with local inference providers and the manual relay (Step 2). They
// are re-exported here so the web provider's contract surface stays stable.
pub use crate::request::{
    allow_request_state, is_terminal_request_state, REQUEST_CANCELLED, REQUEST_CANCEL_REQUESTED,
    REQUEST_COMPLETED, REQUEST_CREATED, REQUEST_FAILED, REQUEST_STREAMING,
    REQUEST_SUBMISSION_UNCONFIRMED, REQUEST_SUBMITTED, REQUEST_SUBMITTING, REQUEST_TIMED_OUT,
};

/// Terminal state for an unsuccessful reply wait (cancelled vs timed_out).
pub use crate::request::reply_wait_state;

/// The single message used when the provider window cannot be re-pointed at a
/// different profile during a running task. A constant so the send path can
/// tell this BUSY state apart from real page drift instead of string-matching
/// an inline literal.
pub const PROFILE_LOCKED: &str = "cannot change provider profile while an agent task is active";

/// Coarse, non-sensitive failure category for diagnostics and the UI. Never
/// carries prompt or reply text.
pub fn error_category(e: &ProviderError) -> &'static str {
    match e {
        ProviderError::NeedsLogin => "login_required",
        ProviderError::BridgeUnreachable(_) => "page_unavailable",
        ProviderError::ProfileLocked(_) => "busy",
        ProviderError::PageChanged(_) => "page_changed",
        ProviderError::Timeout(_) => "timeout",
        ProviderError::SendFailed(_) => "send_failed",
    }
}

fn mounted_adapter_id(state: &WebviewState) -> String {
    state
        .mounted
        .lock()
        .unwrap()
        .as_ref()
        .map(|m| m.adapter_id.clone())
        .unwrap_or_else(|| "web".into())
}

/// Emit one lifecycle transition (metadata only). Returns false when the
/// transition was suppressed by the terminal-state guard.
fn emit_request_state(
    app: &tauri::AppHandle,
    state: &WebviewState,
    provider: &str,
    request_id: &str,
    next: &str,
    category: Option<&str>,
) -> bool {
    // Step 2: the shared registry is the canonical gate — it validates the
    // transition, enforces at most one terminal outcome per request across
    // ALL providers, and builds the metadata-only event payload. `begin` here
    // is defensive: a request whose `created` event was missed (e.g. an older
    // page session) is registered on first contact, never re-created.
    let registry = crate::request::registry_of(app);
    let task_id = state.active_task.lock().unwrap().clone();
    let conversation_id = state.active_conversation.lock().unwrap().clone();
    registry.begin(
        request_id,
        provider,
        task_id.as_deref(),
        conversation_id.as_deref(),
    );
    match registry.transition(request_id, next, category) {
        Some(record) => {
            use tauri::Emitter;
            let _ = app.emit(
                "evt",
                crate::request::request_event_payload(&record, category),
            );
            true
        }
        None => false,
    }
}

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
    /// Runtime identity reported by the current injected adapter instance.
    pub runtime_session: Mutex<Option<String>>,
    /// Sequence captured immediately before a send, so a fast reply cannot be
    /// missed if it arrives before the agent begins waiting.
    pub response_baseline: std::sync::atomic::AtomicU64,
    /// Last reply text visible on the page immediately BEFORE a send. The
    /// read-only backstop uses it to tell a genuinely new answer from the
    /// previous turn that is still rendered in the same provider chat.
    pub response_baseline_text: Mutex<String>,
    /// Correlation ID of the send currently awaiting a reply. Pushes carrying
    /// any other (or no) ID belong to an earlier round and are rejected.
    pub active_request: Mutex<Option<String>>,
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
    /// Whether the provider webview is parked off-screen instead of hidden
    /// (parking keeps WebView2 timers live during a task).
    pub parked: Mutex<bool>,
    /// Last bridge error string, for diagnostics.
    pub last_bridge_error: Mutex<Option<String>>,
    /// Set when the last send was clicked but the provider did not confirm the
    /// prompt entered its conversation (unknown outcome — never resent).
    pub submission_unconfirmed: Mutex<Option<String>>,
    /// Page-reported generation failure for the active request (request ID,
    /// bounded message). Wakes the reply waiter with an honest failure instead
    /// of letting it run to the full response deadline.
    pub response_error: Mutex<Option<(String, String)>>,
    /// Whether the first streaming transition was already emitted for the
    /// active request (partial previews can arrive many times).
    pub request_streaming: Mutex<bool>,
    /// Task and conversation identity of the active request, kept for the
    /// shared request registry's correlation + diagnostics (Step 2).
    pub active_task: Mutex<Option<String>>,
    pub active_conversation: Mutex<Option<String>>,
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
        self.call_with_timeout(method, arg, CALL_TIMEOUT_MS).await
    }

    async fn call_with_timeout(
        &self,
        method: &str,
        arg: &Value,
        timeout_ms: u64,
    ) -> Result<Value, ProviderError> {
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
        let reply = crate::bridge::BridgeHub::wait(rx, timeout_ms)
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

    /// Emit one lifecycle transition for this provider (metadata only).
    fn emit_state(&self, request_id: &str, next: &str, category: Option<&str>) {
        emit_request_state(
            &self.app,
            &self.state,
            &self.adapter.id,
            request_id,
            next,
            category,
        );
    }

    /// Start one request: assign its correlation ID, emit `created`, run the
    /// send path, and report exactly one terminal `failed` if it errors.
    pub async fn send(
        &mut self,
        conversation_id: &str,
        task_id: &str,
        text: &str,
        first_of_task: bool,
    ) -> Result<(), ProviderError> {
        // One correlation ID per send: Rust generates it, the page echoes it on
        // every push, and on_assistant_message rejects anything else. This is
        // what stops an abandoned round's late completion from being used as
        // the answer to a newer prompt.
        let request_id = format!(
            "{task_id}.{}",
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        );
        *self.state.active_request.lock().unwrap() = Some(request_id.clone());
        *self.state.response_error.lock().unwrap() = None;
        *self.state.request_streaming.lock().unwrap() = false;
        *self.state.active_task.lock().unwrap() = Some(task_id.to_string());
        *self.state.active_conversation.lock().unwrap() = Some(conversation_id.to_string());
        self.emit_state(&request_id, REQUEST_CREATED, None);
        let result = self
            .send_inner(&request_id, conversation_id, text, first_of_task)
            .await;
        if let Err(e) = &result {
            self.emit_state(&request_id, REQUEST_FAILED, Some(error_category(e)));
        }
        result
    }

    async fn send_inner(
        &mut self,
        request_id: &str,
        conversation_id: &str,
        text: &str,
        first_of_task: bool,
    ) -> Result<(), ProviderError> {
        self.state.stream.lock().unwrap().clear();
        if !is_mounted(&self.state, &self.profile_id, &self.adapter.id) {
            mount(&self.app, &self.profile_id, &self.adapter, &self.state)
                .await
                .map_err(|e| {
                    // A provider switch during an active task is a BUSY state,
                    // not DOM drift: report it as such.
                    if e == PROFILE_LOCKED {
                        ProviderError::ProfileLocked(e)
                    } else {
                        ProviderError::PageChanged(e)
                    }
                })?;
        }
        // Keep the provider page hidden during ordinary work. The UI only
        // reveals it after an explicit sign-in action or a login-required event.

        // A6: never assume the page is up before the first push event.
        self.wait_ready(20_000).await.map_err(|e| {
            ProviderError::BridgeUnreachable(set_bridge_err(&self.state.last_bridge_error, e))
        })?;

        // Ask the page directly what it sees. This single probe drives both the
        // login gate and the composer check (no duplicate RPCs).
        let info = match self.call("page_info", &json!(null)).await {
            Ok(info) => info,
            Err(e) => return Err(e),
        };
        let page_login_state = info["login"]["state"].as_str().unwrap_or("unknown");
        let input_found = info["input_found"].as_bool() == Some(true);

        match page_login_state {
            "logged_in" => {}
            "logged_out" | "challenge" => {
                let reason = info["login"]["reason"]
                    .as_str()
                    .unwrap_or("sign-in is required")
                    .to_string();
                let _ = self.app.emit(
                    "evt",
                    json!({"kind": "provider-login-required", "adapter": self.adapter.name, "reason": reason}),
                );
                // Give the user a bounded window to finish signing in inside the
                // provider window before failing the send.
                match self.await_login(180).await {
                    Ok(_) => {}
                    Err(_) => return Err(ProviderError::NeedsLogin),
                }
            }
            _ => {
                // "unknown"/"loading": the detector could not positively confirm
                // an authenticated session. A visible, editable composer with no
                // login/challenge signals is enough to ATTEMPT the send — the
                // submission-confirmation + response-push path decides the real
                // outcome, and unknown outcomes are never resent.
                if input_found {
                    let reason = info["login"]["reason"]
                        .as_str()
                        .unwrap_or("provider login state is unverified")
                        .to_string();
                    *self.state.submission_unconfirmed.lock().unwrap() = None;
                    let _ = self.app.emit(
                        "evt",
                        json!({
                            "kind": "provider-login-unverified",
                            "adapter": self.adapter.name,
                            "reason": reason,
                        }),
                    );
                } else {
                    // No composer and no definitive state: give the SPA a
                    // bounded chance to finish rendering before declaring it
                    // unreachable.
                    match self.await_known_login(Duration::from_secs(30)).await {
                        Ok(LoginState::LoggedIn { .. }) => {}
                        Ok(LoginState::LoggedOut { .. }) | Ok(LoginState::Challenge { .. }) => {
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
                        _ => {
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

        // Reuse the provider chat for every task in the same stable Neelima
        // conversation. A different conversation starts a new provider chat.
        let already = self.state.chat_started_for.lock().unwrap().clone();
        if should_start_provider_chat(first_of_task, already.as_deref(), conversation_id) {
            if let Err(e) = self.fire("new_chat", &json!(null)) {
                return Err(ProviderError::PageChanged(format!(
                    "could not start a provider chat: {e}"
                )));
            }
            *self.state.chat_started_for.lock().unwrap() = Some(conversation_id.to_string());
        }

        // Ensure the composer still exists immediately before the send; an SPA
        // navigation between the probe above and the send can invalidate it.
        if page_login_state == "logged_in" || input_found {
            let info = if page_login_state == "logged_in" {
                match self.call("page_info", &json!(null)).await {
                    Ok(info) => info,
                    Err(e) => return Err(e),
                }
            } else {
                info.clone()
            };
            if info["input_found"].as_bool() != Some(true) {
                return Err(ProviderError::PageChanged(format!(
                    "chat composer is no longer available (page state: {})",
                    info["login"]["reason"].as_str().unwrap_or("unknown")
                )));
            }
        }

        let baseline = self.state.last_message.lock().unwrap().0;
        self.state
            .response_baseline
            .store(baseline, Ordering::Release);
        // Snapshot the reply text already on screen. One reused provider chat
        // keeps the previous answer mounted, so "has a reply" alone is not
        // proof that the NEW prompt was answered.
        let baseline_text = capture_reply_detail(&self.app, &self.hub, 3_000)
            .await
            .ok()
            .flatten()
            .and_then(|v| v["text"].as_str().map(str::to_owned))
            .unwrap_or_default();
        *self.state.response_baseline_text.lock().unwrap() = baseline_text.clone();
        *self.state.submission_unconfirmed.lock().unwrap() = None;

        // A10 + budget: trust only the explicit acknowledgement returned after
        // the provider UI confirms that the submitted prompt entered its chat.
        // The page-side path always resolves (~11 s worst case) — this budget is
        // larger, so the RPC is never cancelled mid-submission.
        self.emit_state(request_id, REQUEST_SUBMITTING, None);
        let result = self
            .call_with_timeout(
                "send_message",
                &json!({
                    "text": text,
                    "quiet_ms": self.adapter.quiet_ms,
                    "request_id": request_id,
                }),
                SEND_CALL_TIMEOUT_MS,
            )
            .await?;
        classify_send_result(&self.state, &result)?;
        // Metadata-only lifecycle event: identifies the last successful stage
        // without carrying prompt or response text.
        self.emit_state(
            request_id,
            if result["submission_confirmed"].as_bool() == Some(true) {
                REQUEST_SUBMITTED
            } else {
                REQUEST_SUBMISSION_UNCONFIRMED
            },
            None,
        );

        // Read-only backstop. The page's own completion watch is the primary
        // path; this covers the cases where it is silenced (renderer
        // throttling, an SPA container swap, selector drift, a stuck stop
        // control). It NEVER resends the prompt and NEVER touches the page.
        //
        // Delivery rule: a non-empty reply that differs from the pre-send text,
        // no streaming stop control, and the same text on two consecutive
        // polls. Two agreeing reads keep half-streamed tool blocks from being
        // delivered as if they were complete.
        let net_app = self.app.clone();
        let net_state = self.state.clone();
        let net_hub = self.hub.clone();
        let net_baseline = baseline;
        let net_timeout_ms = self.adapter.response_timeout_ms;
        let net_request_id = request_id.to_string();
        tauri::async_runtime::spawn(async move {
            let started = tokio::time::Instant::now();
            let deadline = started + Duration::from_millis(net_timeout_ms);
            let mut stable: Option<String> = None;
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                if !*net_state.task_active.lock().unwrap() {
                    return; // task finished or aborted; nothing to deliver to
                }
                if net_state.response_baseline.load(Ordering::Acquire) != net_baseline {
                    return; // a newer send owns the reply slot now
                }
                let already = {
                    let (seq, text) = net_state.last_message.lock().unwrap().clone();
                    seq > net_baseline && !text.trim().is_empty()
                };
                if already {
                    return; // the watch delivered first
                }
                let detail = capture_reply_detail(&net_app, &net_hub, 8_000)
                    .await
                    .ok()
                    .flatten();
                let candidate = backstop_candidate(detail.as_ref(), &baseline_text);
                match candidate {
                    Some(text) if stable.as_deref() == Some(text.as_str()) => {
                        let mut last = net_state.last_message.lock().unwrap();
                        if last.0 > net_baseline {
                            return; // lost the race with the watch: deliver once
                        }
                        last.0 = net_baseline + 1;
                        last.1 = text.clone();
                        drop(last);
                        // The page watch is the primary reporter; when the
                        // backstop wins instead, close the lifecycle here so
                        // the contract still reports one terminal state. Emit
                        // the state BEFORE waking the agent, so a fast next
                        // round cannot observe a stale "streaming" status.
                        let provider = mounted_adapter_id(&net_state);
                        let state_ref: &WebviewState = &net_state;
                        emit_request_state(
                            &net_app,
                            state_ref,
                            &provider,
                            &net_request_id,
                            REQUEST_COMPLETED,
                            None,
                        );
                        net_state.message_notify.notify_one();
                        net_hub.note(format!(
                            "backstop delivered reply after {}ms (len={})",
                            started.elapsed().as_millis(),
                            text.len()
                        ));
                        let _ = net_app.emit(
                            "evt",
                            json!({"kind": "assistant-captured", "at_ms": 0, "len": text.len()}),
                        );
                        return;
                    }
                    other => stable = other,
                }
                if tokio::time::Instant::now() >= deadline {
                    net_hub.note("backstop gave up at the reply deadline".into());
                    return;
                }
            }
        });
        Ok(())
    }

    /// Wait for the assistant message push (A3). Cancel-safe via Notify.
    pub async fn wait_reply(&mut self, cancel: Arc<Notify>) -> Result<String, String> {
        let start_seq = self.state.response_baseline.load(Ordering::Acquire);
        // An unconfirmed submission may or may not have reached the provider:
        // wait a bounded window for a reply push, then report the uncertainty
        // instead of sitting out the full provider timeout.
        let unconfirmed = self.state.submission_unconfirmed.lock().unwrap().clone();
        let timeout = if unconfirmed.is_some() {
            Duration::from_millis(UNCONFIRMED_REPLY_WAIT_MS.min(self.adapter.response_timeout_ms))
        } else {
            Duration::from_millis(self.adapter.response_timeout_ms)
        };
        let outcome = wait_for_reply_state(&self.state, start_seq, timeout, cancel).await;
        match outcome {
            Ok(text) => Ok(text),
            Err(e) => {
                let provider_failure = self.state.response_error.lock().unwrap().is_some();
                let request_id = self.state.active_request.lock().unwrap().clone();
                if let Some(request_id) = request_id.as_deref() {
                    if provider_failure {
                        self.emit_state(request_id, REQUEST_FAILED, Some("provider_error"));
                    } else if e == "stopped" {
                        // C5: report the cancel REQUEST first, then its
                        // completion — the two are distinguishable.
                        self.emit_state(request_id, REQUEST_CANCEL_REQUESTED, None);
                        self.emit_state(request_id, reply_wait_state(&e), None);
                    } else {
                        self.emit_state(request_id, reply_wait_state(&e), None);
                    }
                }
                // Tear down the page-side watch. Waiting again after it has
                // finished is not allowed, and a late completion push must not
                // land in the next request's window.
                let _ = self.fire("cancel_response", &json!(null));
                if let Some(note) = self.state.submission_unconfirmed.lock().unwrap().clone() {
                    if e.contains("response timeout") {
                        return Err(format!(
                            "{} and no assistant reply arrived within {}s. The prompt outcome is unknown — Neelima did NOT resend it. Open the provider window to check the conversation, then retry or start a new task.",
                            note,
                            timeout.as_secs()
                        ));
                    }
                }
                Err(e)
            }
        }
    }
}

/// One-shot, read-only reply capture from the provider page via the
/// `capture_reply` page method. Returns Some(text) only when the page reports
/// a present, non-empty reply candidate. Never resends anything.
pub async fn capture_reply_once(
    app: &tauri::AppHandle,
    hub: &Arc<BridgeHub>,
    timeout_ms: u64,
) -> Result<Option<String>, String> {
    match capture_reply_detail(app, hub, timeout_ms).await {
        Ok(Some(v)) => {
            let has_reply = v["has_reply"].as_bool() == Some(true);
            let text = v["text"].as_str().unwrap_or("").to_string();
            if has_reply && !text.trim().is_empty() {
                Ok(Some(text))
            } else {
                Ok(None)
            }
        }
        Ok(None) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Full `capture_reply` payload (text, assistant count, stop-control state).
/// Metadata only — the payload never leaves this process except as the reply
/// text the agent already needs. Returns None when the page did not answer.
pub async fn capture_reply_detail(
    app: &tauri::AppHandle,
    hub: &Arc<BridgeHub>,
    timeout_ms: u64,
) -> Result<Option<Value>, String> {
    let Some(wv) = app.get_webview(PROVIDER_LABEL) else {
        return Ok(None);
    };
    let (req_id, nonce, rx) = hub.begin();
    let js = format!(
        "window.__LB__ && window.__LB__.call('capture_reply', null, {:?}, {:?})",
        req_id, nonce
    );
    if let Err(e) = wv.eval(js) {
        hub.cancel(&req_id);
        return Err(format!("capture eval failed: {e}"));
    }
    match BridgeHub::wait(rx, timeout_ms).await {
        Ok(v) if v["ok"] == true => Ok(Some(v["value"].clone())),
        Ok(_) => Ok(None),
        Err(_) => {
            hub.cancel(&req_id);
            Ok(None)
        }
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
        // A page-reported generation failure ends the wait immediately; the
        // agent must not sit out the full provider deadline after an error.
        if let Some((_, message)) = state.response_error.lock().unwrap().clone() {
            return Err(format!("provider reported an error: {message}"));
        }
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

/// The read-only backstop's delivery rule. A candidate must be a real reply,
/// not the previous turn still mounted in a reused provider chat, and not a
/// reply that is still streaming.
fn backstop_candidate(detail: Option<&Value>, baseline_text: &str) -> Option<String> {
    let v = detail?;
    let has_reply = v["has_reply"].as_bool() == Some(true);
    let streaming = v["stop_visible"].as_bool() == Some(true);
    let text = v["text"].as_str().unwrap_or("").trim().to_string();
    (!text.is_empty() && has_reply && !streaming && text != baseline_text).then_some(text)
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
    /// A DIFFERENT provider profile is mounted while this task is running, so
    /// no send can be attempted. This is not page drift and must never be
    /// reported as "provider page changed" — that message would send the user
    /// hunting for stale selectors while the real cause is provider switching.
    ProfileLocked(String),
    PageChanged(String),
    Timeout(String),
    SendFailed(String),
}

impl ProviderError {
    pub fn message(&self) -> String {
        match self {
            ProviderError::NeedsLogin => "Provider sign-in or verification is required. Open the provider sign-in window, complete it, then retry; or select a configured API/local model.".into(),
            ProviderError::BridgeUnreachable(d) => format!("can't reach the provider page ({d})"),
            ProviderError::ProfileLocked(d) => format!(
                "{d}. Neelima kept the provider window it is already using; finish or stop the running task before switching providers, then retry."
            ),
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

fn classify_send_result(state: &WebviewState, result: &Value) -> Result<(), ProviderError> {
    match result["error_type"].as_str() {
        // Nothing was clicked / nothing was submitted: a known, safe failure.
        Some("page_changed") => Err(ProviderError::PageChanged(
            result["error"]
                .as_str()
                .unwrap_or("provider input selector is missing")
                .to_string(),
        )),
        // The click happened but the provider did not confirm the prompt
        // entered its conversation. Outcome UNKNOWN: continue (the response
        // watch stays armed in the page), remember the uncertainty, and never
        // resend. wait_reply reports it honestly if no reply arrives.
        Some("send_unconfirmed") => {
            let note = result["warning"]
                .as_str()
                .unwrap_or("the provider did not confirm the prompt entered its conversation")
                .to_string();
            *state.submission_unconfirmed.lock().unwrap() = Some(note);
            Ok(())
        }
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
pub fn on_page_ready(app: &tauri::AppHandle, runtime_id: &str) {
    let st: State<'_, Arc<WebviewState>> = app.state();
    if !valid_runtime_id(runtime_id) {
        return;
    }
    *st.runtime_session.lock().unwrap() = Some(runtime_id.to_string());
    *st.last_message.lock().unwrap() = (0, String::new());
    st.response_baseline.store(0, Ordering::Release);
    // A (re)loaded document has no send bound to it; drop any stale ID so a
    // previous page's completion cannot answer this page's request.
    *st.active_request.lock().unwrap() = None;
    *st.response_error.lock().unwrap() = None;
    *st.request_streaming.lock().unwrap() = false;
    *st.active_task.lock().unwrap() = None;
    *st.active_conversation.lock().unwrap() = None;
    st.stream.lock().unwrap().clear();
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

/// Streaming preview only. Rejected unless it belongs to the live page and
/// the send Rust is currently waiting on; it never feeds the agent loop.
pub fn on_assistant_partial(
    webview: &Webview,
    runtime_id: &str,
    request_id: &str,
    text: String,
    truncated: bool,
) {
    if text.trim().is_empty() {
        return;
    }
    if let Some(app) = webview.app_handle_or_empty() {
        let st: State<'_, Arc<WebviewState>> = app.state();
        let accepted = {
            let current_runtime = st.runtime_session.lock().unwrap();
            let active_request = st.active_request.lock().unwrap();
            current_runtime.as_deref() == Some(runtime_id)
                && active_request.as_deref() == Some(request_id)
        };
        if !accepted {
            let _ = app.emit(
                "evt",
                json!({"kind": "assistant-partial-rejected", "request_id": request_id}),
            );
            return;
        }
        {
            let mut stream = st.stream.lock().unwrap();
            if *stream == text {
                return; // nothing new to display
            }
            *stream = text.clone();
        }
        // First preview of this request: report the streaming transition once.
        let mark_streaming = {
            let mut streamed = st.request_streaming.lock().unwrap();
            let first = !*streamed;
            *streamed = true;
            first
        };
        if mark_streaming {
            let provider = mounted_adapter_id(&st);
            let state_ref: &WebviewState = &st;
            emit_request_state(
                &app,
                state_ref,
                &provider,
                request_id,
                REQUEST_STREAMING,
                None,
            );
        }
        let _ = app.emit(
            "evt",
            json!({
                "kind": "assistant-partial",
                "request_id": request_id,
                "text": text,
                "truncated": truncated
            }),
        );
    }
}

/// Page-side generation failure (provider error banner, interrupted stream,
/// removed response). Only the active request may fail; a stale report is
/// diagnosed and dropped. Never carries prompt/reply text.
pub fn on_response_error(webview: &Webview, runtime_id: &str, request_id: &str, message: &str) {
    if let Some(app) = webview.app_handle_or_empty() {
        let st: State<'_, Arc<WebviewState>> = app.state();
        let accepted = {
            let current_runtime = st.runtime_session.lock().unwrap();
            let active_request = st.active_request.lock().unwrap();
            current_runtime.as_deref() == Some(runtime_id)
                && active_request.as_deref() == Some(request_id)
        };
        if !accepted {
            let _ = app.emit(
                "evt",
                json!({
                    "kind": "assistant-push-rejected",
                    "request_id": request_id,
                    "reason": "stale provider error report"
                }),
            );
            return;
        }
        let bounded: String = message.chars().take(300).collect();
        *st.response_error.lock().unwrap() = Some((request_id.to_string(), bounded));
        st.message_notify.notify_one();
    }
}

pub fn on_assistant_message(
    webview: &Webview,
    runtime_id: &str,
    request_id: &str,
    text: String,
    seq: u64,
) {
    let _ = webview;
    if let Some(app) = webview.app_handle_or_empty() {
        let st: State<'_, Arc<WebviewState>> = app.state();
        let accepted = {
            let current_runtime = st.runtime_session.lock().unwrap();
            let active_request = st.active_request.lock().unwrap().clone();
            let mut last = st.last_message.lock().unwrap();
            if current_runtime
                .as_deref()
                .map(|current| {
                    accept_assistant_push(
                        current,
                        last.0,
                        runtime_id,
                        seq,
                        active_request.as_deref(),
                        request_id,
                    )
                })
                .unwrap_or(false)
                && !text.trim().is_empty()
            {
                *last = (seq, text.clone());
                true
            } else {
                false
            }
        };
        if !accepted {
            // Correlation rejections must be diagnosable: a silently dropped
            // push looks identical to "no response ever arrived" and wastes a
            // live debugging session. Diagnose stale runtime vs stale seq.
            let (current_runtime, last_seq, active_request) = {
                let current_runtime = st.runtime_session.lock().unwrap();
                let last = st.last_message.lock().unwrap();
                let active = st.active_request.lock().unwrap().clone();
                (current_runtime.clone(), last.0, active)
            };
            let reason = match current_runtime.as_deref() {
                None => "no page ready has been processed yet",
                Some(current) if current != runtime_id => "stale runtime (page reloaded mid-wait)",
                Some(_) if active_request.as_deref() != Some(request_id) => {
                    "stale request (reply belongs to an earlier send)"
                }
                Some(_) if seq <= last_seq => "stale sequence (duplicate or late push)",
                Some(_) => "empty response text",
            };
            let _ = app.emit(
                "evt",
                json!({
                    "kind": "assistant-push-rejected",
                    "request_id": request_id,
                    "seq": seq,
                    "reason": reason
                }),
            );
            return;
        }
        // A delivered reply is positive proof of an authenticated provider
        // session: flip the login posture so the sign-in card stops claiming
        // "unknown" for a profile that is demonstrably chatting.
        {
            let mut login = st.login.lock().unwrap();
            if !matches!(*login, LoginState::LoggedIn { .. }) {
                let url = match &*login {
                    LoginState::LoggedIn { url }
                    | LoginState::LoggedOut { url }
                    | LoginState::Unknown { url, .. }
                    | LoginState::Loading { url, .. }
                    | LoginState::Challenge { url, .. } => url.clone(),
                };
                *login = LoginState::LoggedIn { url };
            }
        }
        st.stream.lock().unwrap().clear();
        st.message_notify.notify_one();
        st.login_changed.notify_waiters();
        let _ = app.emit(
            "evt",
            json!({
                "kind": "assistant-stream-complete",
                "request_id": request_id,
                "len": text.len()
            }),
        );
        let provider = mounted_adapter_id(&st);
        let state_ref: &WebviewState = &st;
        emit_request_state(
            &app,
            state_ref,
            &provider,
            request_id,
            REQUEST_COMPLETED,
            None,
        );
        let _ = app.emit(
            "evt",
            json!({"kind": "provider-login-state", "state": "logged_in", "url": "", "reason": "assistant reply received"}),
        );
    }
}

fn valid_runtime_id(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn should_start_provider_chat(
    first_of_task: bool,
    active_conversation: Option<&str>,
    conversation_id: &str,
) -> bool {
    first_of_task && active_conversation != Some(conversation_id)
}

fn accept_runtime_sequence(
    current_runtime: &str,
    last_seq: u64,
    incoming_runtime: &str,
    incoming_seq: u64,
) -> bool {
    current_runtime == incoming_runtime && incoming_seq > last_seq
}

/// Every push must match the live page instance, be newer than the last
/// delivered sequence, AND belong to the send Rust is currently waiting on.
/// The request check is what prevents a late completion from an abandoned
/// round being used as the answer to a newer prompt.
fn accept_assistant_push(
    current_runtime: &str,
    last_seq: u64,
    incoming_runtime: &str,
    incoming_seq: u64,
    active_request: Option<&str>,
    incoming_request: &str,
) -> bool {
    accept_runtime_sequence(current_runtime, last_seq, incoming_runtime, incoming_seq)
        && active_request == Some(incoming_request)
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
        return Err(PROFILE_LOCKED.to_string());
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
    *state.runtime_session.lock().unwrap() = None;
    *state.chat_started_for.lock().unwrap() = None;
    *state.last_bridge_error.lock().unwrap() = None;
    *state.hidden_since.lock().unwrap() = None;
    *state.parked.lock().unwrap() = false;

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
        .focused(false);
    #[cfg(windows)]
    {
        // Keep WebView2 timers and rendering live while the pane is parked or
        // hidden during a task. The first flag list is Tauri's Windows default
        // --disable-features set (kept intact); the rest disable background
        // throttling so a busy task is never slowed by pane visibility.
        builder = builder.additional_browser_args(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows",
        );
    }
    let mut builder = builder.on_navigation(move |url| {
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

/// A7: when a task is active, PARK the webview (move it off-screen) instead of
/// hiding it — a hidden WebView2 page reports visibilityState "hidden", which
/// can throttle timers and defer rendering and has been observed to stretch
/// the page-side send path past Rust's budget. Parked at its real size, the
/// page stays fully live while never covering the UI. When no task runs, hide
/// as before and schedule the idle destroy sweep.
/// Hide the provider pane. It is a real browser view: it must never be left
/// partially on screen. Parking it at a negative offset used the pane's
/// *reported* rect, which is 0×0 until the provider screen has been laid out —
/// so during a chat task the webview was nudged a few hundred pixels left and
/// stayed visible over the UI. Hiding it outright removes that failure mode.
///
/// The page keeps working while hidden: mount() disables Chromium background
/// throttling for this webview and the runtime overrides document visibility,
/// and live bridge logs show ready/login pushes arriving from a hidden pane.
pub fn hide_if_any(app: &tauri::AppHandle, state: &WebviewState) {
    if let Some(wv) = app.get_webview(PROVIDER_LABEL) {
        let _ = wv.hide();
        *state.parked.lock().unwrap() = false;
        if *state.task_active.lock().unwrap() {
            // An active task owns the page: never queue its idle destruction.
            *state.hidden_since.lock().unwrap() = None;
            return;
        }
        *state.hidden_since.lock().unwrap() = Some(Instant::now());
        let app = app.clone();
        let state = app.state::<Arc<WebviewState>>().inner().clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(HIDDEN_IDLE_DESTROY_MS)).await;
            destroy_if_idle(&app, &state, false);
        });
    }
}

/// Return a parked/hidden provider webview to its real pane position.
fn unpark(wv: &tauri::Webview, state: &WebviewState) {
    if *state.parked.lock().unwrap() {
        let rect = *state.rect.lock().unwrap();
        let _ = wv.set_position(Position::Physical(tauri::PhysicalPosition::new(
            rect.x, rect.y,
        )));
        *state.parked.lock().unwrap() = false;
    }
}

pub fn apply_rect(app: &tauri::AppHandle, state: &WebviewState, rect: Rect) {
    *state.rect.lock().unwrap() = rect;
    if let Some(wv) = app.get_webview(PROVIDER_LABEL) {
        let _ = wv.set_size(Size::Physical(tauri::PhysicalSize::new(
            rect.w.max(1) as u32,
            rect.h.max(1) as u32,
        )));
        if *state.parked.lock().unwrap() {
            // Keep the pane parked off-screen at its (possibly new) size.
            let _ = wv.set_position(Position::Physical(tauri::PhysicalPosition::new(
                -rect.w.max(1) - 200,
                rect.y,
            )));
        } else {
            let _ = wv.set_position(Position::Physical(tauri::PhysicalPosition::new(
                rect.x, rect.y,
            )));
        }
    }
}

pub fn set_visible(app: &tauri::AppHandle, state: &WebviewState, visible: bool) {
    if let Some(wv) = app.get_webview(PROVIDER_LABEL) {
        if visible {
            unpark(&wv, state);
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

    #[test]
    fn assistant_sequence_accepts_only_current_runtime_and_strictly_new_sequences() {
        assert!(accept_runtime_sequence("runtime-a", 0, "runtime-a", 1));
        assert!(!accept_runtime_sequence("runtime-a", 1, "runtime-a", 1));
        assert!(!accept_runtime_sequence("runtime-a", 3, "runtime-a", 2));
        assert!(!accept_runtime_sequence("runtime-b", 9, "runtime-a", 10));
        assert!(accept_runtime_sequence("runtime-b", 0, "runtime-b", 1));
    }

    /// The cross-round leak: a watch from send #1 completes after send #2 has
    /// started. Same page, higher sequence — only the request ID distinguishes
    /// them, and the stale push must be rejected.
    #[test]
    fn assistant_push_must_match_the_active_request_id() {
        assert!(accept_assistant_push(
            "runtime-a",
            2,
            "runtime-a",
            3,
            Some("task-1.aaaaaaaa"),
            "task-1.aaaaaaaa"
        ));
        assert!(!accept_assistant_push(
            "runtime-a",
            2,
            "runtime-a",
            9,
            Some("task-1.bbbbbbbb"),
            "task-1.aaaaaaaa"
        ));
        assert!(!accept_assistant_push(
            "runtime-a",
            2,
            "runtime-a",
            9,
            None,
            "task-1.aaaaaaaa"
        ));
        assert!(!accept_assistant_push(
            "runtime-a",
            2,
            "runtime-b",
            3,
            Some("task-1.aaaaaaaa"),
            "task-1.aaaaaaaa"
        ));
        assert!(!accept_assistant_push(
            "runtime-a",
            5,
            "runtime-a",
            5,
            Some("task-1.aaaaaaaa"),
            "task-1.aaaaaaaa"
        ));
    }

    /// The read-only backstop must never resurface the previous turn of a
    /// reused provider chat, never deliver a still-streaming reply, and never
    /// deliver an empty capture.
    #[test]
    fn backstop_only_accepts_a_new_finished_reply() {
        let old = json!({"has_reply": true, "stop_visible": false, "text": "OLD REPLY"});
        assert_eq!(backstop_candidate(Some(&old), "OLD REPLY"), None);

        let streaming = json!({"has_reply": true, "stop_visible": true, "text": "NEW"});
        assert_eq!(backstop_candidate(Some(&streaming), "OLD REPLY"), None);

        let empty = json!({"has_reply": false, "stop_visible": false, "text": ""});
        assert_eq!(backstop_candidate(Some(&empty), ""), None);

        let fresh = json!({"has_reply": true, "stop_visible": false, "text": "  NEW REPLY  "});
        assert_eq!(
            backstop_candidate(Some(&fresh), "OLD REPLY").as_deref(),
            Some("NEW REPLY")
        );
        assert_eq!(backstop_candidate(None, ""), None);
    }

    #[test]
    fn provider_chat_is_reused_for_followups_and_reset_for_a_new_conversation() {
        assert!(!should_start_provider_chat(
            true,
            Some("conversation-a"),
            "conversation-a"
        ));
        assert!(!should_start_provider_chat(
            false,
            Some("conversation-a"),
            "conversation-a"
        ));
        assert!(should_start_provider_chat(
            true,
            Some("conversation-a"),
            "conversation-b"
        ));
        assert!(should_start_provider_chat(true, None, "conversation-a"));
    }

    #[test]
    fn runtime_ids_are_bounded_and_safe_for_bridge_identity() {
        assert!(valid_runtime_id("session-123456"));
        assert!(!valid_runtime_id("short"));
        assert!(!valid_runtime_id("runtime id with spaces"));
        assert!(!valid_runtime_id(&"x".repeat(129)));
    }

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
        let state = WebviewState::default();
        let err = classify_send_result(
            &state,
            &json!({
                "error_type": "page_changed",
                "error": "input selector was not found"
            }),
        )
        .unwrap_err();
        assert!(matches!(err, ProviderError::PageChanged(_)));
        assert!(classify_send_result(&state, &json!({"sent": true})).is_ok());
        assert!(state.submission_unconfirmed.lock().unwrap().is_none());
    }

    /// The r8 regression: a clicked-but-unconfirmed submission is an UNKNOWN
    /// outcome — the send is accepted (the response watch stays armed in the
    /// page), the uncertainty is recorded, and nothing is resent.
    #[test]
    fn unconfirmed_submission_is_accepted_with_uncertainty_recorded() {
        let state = WebviewState::default();
        let result = classify_send_result(
            &state,
            &json!({
                "sent": true,
                "submission_confirmed": false,
                "error_type": "send_unconfirmed",
                "warning": "the provider did not confirm the prompt entered its conversation; awaiting a response without resending"
            }),
        );
        assert!(result.is_ok(), "unconfirmed must NOT abort the task");
        let note = state.submission_unconfirmed.lock().unwrap().clone();
        assert!(
            note.is_some(),
            "uncertainty is recorded for the honest wait message"
        );
        assert!(note.unwrap().contains("did not confirm"));
    }

    /// The send RPC budget must exceed the page-side worst case
    /// (waitForSendButton 3s + waitSubmission 8s ≈ 11s) or a slow-but-succeeding
    /// submission is cancelled mid-flight and its late result is discarded.
    #[test]
    fn send_budget_exceeds_page_side_worst_case() {
        // The page can spend ~11s locating the button and confirming the
        // submission; the RPC budget must keep margin over that.
        const {
            assert!(SEND_CALL_TIMEOUT_MS > 13_000);
            assert!(CALL_TIMEOUT_MS <= SEND_CALL_TIMEOUT_MS);
            assert!(UNCONFIRMED_REPLY_WAIT_MS >= 30_000);
        };
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

    /// Step 1 contract: every request reports ordered transitions and exactly
    /// one terminal outcome, even if error paths race after it.
    #[test]
    fn lifecycle_reports_exactly_one_terminal_state_per_request() {
        let mut terminal = None;
        for state in [
            REQUEST_CREATED,
            REQUEST_SUBMITTING,
            REQUEST_SUBMITTED,
            REQUEST_STREAMING,
        ] {
            assert!(
                allow_request_state(&mut terminal, "r1", state),
                "{state} should be emitted"
            );
        }
        assert!(allow_request_state(&mut terminal, "r1", REQUEST_COMPLETED));
        for late in [
            REQUEST_STREAMING,
            REQUEST_COMPLETED,
            REQUEST_TIMED_OUT,
            REQUEST_CANCELLED,
        ] {
            assert!(
                !allow_request_state(&mut terminal, "r1", late),
                "{late} after the terminal state must be suppressed"
            );
        }
        // A different request ID begins a fresh lifecycle.
        assert!(allow_request_state(&mut terminal, "r2", REQUEST_CREATED));
        assert!(allow_request_state(&mut terminal, "r2", REQUEST_FAILED));
    }

    #[tokio::test]
    async fn a_page_reported_error_wakes_the_reply_waiter_immediately() {
        let st = WebviewState::default();
        *st.response_error.lock().unwrap() = Some((
            "r1".into(),
            "the provider stopped generating without a reply".into(),
        ));
        let err = wait_for_reply_state(&st, 0, Duration::from_secs(30), Arc::new(Notify::new()))
            .await
            .unwrap_err();
        assert!(err.contains("provider reported an error"), "got: {err}");
        assert!(err.contains("stopped generating"));
    }

    #[test]
    fn terminal_reply_wait_states_distinguish_cancel_from_timeout() {
        assert_eq!(reply_wait_state("stopped"), REQUEST_CANCELLED);
        assert_eq!(reply_wait_state("response timeout"), REQUEST_TIMED_OUT);
        assert!(is_terminal_request_state(REQUEST_CANCELLED));
        assert!(is_terminal_request_state(REQUEST_TIMED_OUT));
        assert!(!is_terminal_request_state(REQUEST_STREAMING));
        assert!(!is_terminal_request_state(REQUEST_SUBMISSION_UNCONFIRMED));
    }

    /// A provider switch during a running task is a BUSY state, not DOM drift:
    /// reporting it as "provider page changed (selectors may be stale)" sent
    /// users hunting for stale selectors while the reply sat on the page.
    #[test]
    fn a_locked_provider_window_is_reported_as_busy_not_page_drift() {
        let err = ProviderError::ProfileLocked(PROFILE_LOCKED.to_string());
        assert_eq!(error_category(&err), "busy");
        let msg = err.message();
        assert!(!msg.contains("selectors may be stale"), "got: {msg}");
        assert!(msg.contains("stop the running task"), "actionable: {msg}");
        assert!(msg.contains(PROFILE_LOCKED), "keeps the real cause: {msg}");
    }

    #[test]
    fn failure_categories_never_carry_page_text() {
        for (err, category) in [
            (ProviderError::NeedsLogin, "login_required"),
            (
                ProviderError::BridgeUnreachable("secret page text".into()),
                "page_unavailable",
            ),
            (ProviderError::PageChanged("secret".into()), "page_changed"),
            (ProviderError::Timeout("secret".into()), "timeout"),
            (ProviderError::SendFailed("secret".into()), "send_failed"),
        ] {
            assert_eq!(error_category(&err), category);
        }
        let st = WebviewState::default();
        let busy = classify_send_result(
            &st,
            &json!({"error_type": "busy", "error": "a prompt is already being submitted"}),
        )
        .unwrap_err();
        assert_eq!(error_category(&busy), "send_failed");
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
