//! Provider abstraction + local model clients (Ollama, LM Studio) + manual relay.
//!
//! The ONLY network destinations allowed anywhere in Neelima are localhost
//! (these two clients) and the pages loaded inside the provider webview.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, Notify};

use crate::settings::LocalProvider as LocalCfg;
use crate::webprov::ProviderError;

#[derive(Clone)]
pub enum Provider {
    /// Embedded provider web chat, driven through the adapter runtime.
    Web(Box<crate::webprov::WebProvider>),
    /// Ollama / LM Studio via localhost HTTP with streaming.
    Local(LocalProvider),
    /// First-class manual relay: the user copies the prompt out and pastes the
    /// reply back. Identical parse/execute/approve pipeline.
    Manual(ManualProvider),
}

impl Provider {
    pub fn describe(&self) -> String {
        match self {
            Provider::Web(w) => format!("web:{}", w.describe()),
            Provider::Local(l) => format!("local:{}", l.describe()),
            Provider::Manual(_) => "manual relay".into(),
        }
    }

    /// Which project-context budget this provider uses (Step 3). Browser chats
    /// and local models have different practical limits, so the budget is not a
    /// single constant.
    pub fn context_kind(&self) -> crate::context::Kind {
        match self {
            Provider::Web(_) => crate::context::Kind::Web,
            Provider::Local(_) => crate::context::Kind::Local,
            Provider::Manual(_) => crate::context::Kind::Manual,
        }
    }

    /// Send a message. `task_id` identifies the task (the web provider uses it
    /// to decide new_chat), `first_of_task` allows the web provider to reset
    /// the chat exactly once per task (A8).
    pub async fn send(
        &mut self,
        task_id: &str,
        conversation_id: &str,
        text: &str,
        first_of_task: bool,
    ) -> Result<(), ProviderError> {
        match self {
            Provider::Web(w) => w.send(conversation_id, task_id, text, first_of_task).await,
            Provider::Local(l) => l
                .send(task_id, text)
                .await
                .map_err(ProviderError::SendFailed),
            Provider::Manual(m) => m
                .send(task_id, text)
                .await
                .map_err(ProviderError::SendFailed),
        }
    }

    /// Wait for the next assistant reply. Returns the raw text.
    pub async fn wait_reply(&mut self, cancel: Arc<Notify>) -> Result<String, String> {
        match self {
            Provider::Web(w) => w.wait_reply(cancel).await,
            Provider::Local(l) => l.wait_reply(cancel).await,
            Provider::Manual(m) => m.wait_reply(cancel).await,
        }
    }
}

// ---------------------------------------------------------------------------
// Manual relay
// ---------------------------------------------------------------------------

/// App-wide slot the UI deposits pasted replies into while a manual relay is
/// active. Managed as Arc<RelaySlot>.
///
/// Race-closure: `send` marks the relay live for its task (and clears stale
/// buffers when the task ID changes, so a buffer never leaks across tasks);
/// `wait_reply` ARMS first, then checks the buffer. A paste delivered while
/// armed goes straight through the channel; one delivered in the pre-arm
/// window — including while the agent is busy executing tool calls of the SAME
/// task between rounds — is buffered and picked up by the next wait, so a
/// paste is never lost. `deliver` fails only when no relay task is live.
pub struct RelaySlot {
    waiter: Mutex<Option<oneshot::Sender<String>>>,
    buffered: Mutex<Option<String>>,
    live: Mutex<Option<String>>,
}

impl Default for RelaySlot {
    fn default() -> Self {
        RelaySlot {
            waiter: Mutex::new(None),
            buffered: Mutex::new(None),
            live: Mutex::new(None),
        }
    }
}

impl RelaySlot {
    /// Called by a manual provider when its task starts sending; clears any
    /// stale buffer from a previous task and marks this task live.
    pub fn note_live(&self, task_id: &str) {
        let mut live = self.live.lock().unwrap();
        if live.as_deref() != Some(task_id) {
            *self.buffered.lock().unwrap() = None;
        }
        *live = Some(task_id.to_string());
    }

    /// Deliver a user-pasted reply. Returns false only when no relay task is
    /// live (matches the historic UI error).
    pub fn deliver(&self, text: String) -> bool {
        let live = self.live.lock().unwrap().is_some();
        if let Some(tx) = self.waiter.lock().unwrap().take() {
            if tx.send(text.clone()).is_ok() {
                return true;
            }
            // Receiver was dropped (stale waiter from a previous round):
            // fall through to buffering when the relay is still live.
        }
        if live {
            *self.buffered.lock().unwrap() = Some(text);
            true
        } else {
            false
        }
    }

    /// Arm a waiter. Call before checking the buffer (arm-then-check closes
    /// the pre-arm race).
    pub fn arm(&self) -> oneshot::Receiver<String> {
        let (tx, rx) = oneshot::channel();
        *self.waiter.lock().unwrap() = Some(tx);
        rx
    }

    /// Take a buffered reply, disarming the fresh waiter. None means keep
    /// waiting on the armed receiver.
    pub fn take_buffered_and_disarm(&self) -> Option<String> {
        let buffered = self.buffered.lock().unwrap().take();
        if buffered.is_some() {
            *self.waiter.lock().unwrap() = None;
        }
        buffered
    }
}

#[derive(Clone)]
pub struct ManualProvider {
    pub app: tauri::AppHandle,
    pub relay: Arc<RelaySlot>,
    /// Task ID of the round currently in send/wait; set by `send`.
    current_task: Arc<Mutex<String>>,
    /// Correlation ID of the round currently in send/wait (Step 2).
    current_request: Arc<Mutex<Option<String>>>,
}

impl ManualProvider {
    pub fn new(app: tauri::AppHandle, relay: Arc<RelaySlot>) -> Self {
        ManualProvider {
            app,
            relay,
            current_task: Arc::new(Mutex::new(String::new())),
            current_request: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn send(&mut self, task_id: &str, text: &str) -> Result<(), String> {
        *self.current_task.lock().unwrap() = task_id.to_string();
        self.relay.note_live(task_id);
        // Step 2 lifecycle: for a human relay, handing the prompt to the user
        // IS the submission — the reply arrives whenever the user pastes it.
        let request_id = format!(
            "{task_id}.{}",
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        );
        *self.current_request.lock().unwrap() = Some(request_id.clone());
        crate::request::begin_and_emit(&self.app, &request_id, "manual", Some(task_id), None);
        crate::request::transition_and_emit(
            &self.app,
            &request_id,
            crate::request::REQUEST_SUBMITTED,
            None,
        );
        use tauri::Emitter;
        let _ = self.app.emit(
            "evt",
            json!({"kind": "relay-outbound", "task_id": task_id, "text": text}),
        );
        Ok(())
    }

    pub async fn wait_reply(&mut self, cancel: Arc<Notify>) -> Result<String, String> {
        let request_id = self.current_request.lock().unwrap().clone();
        let finish = |next: &str, category: Option<&str>| {
            if let Some(request_id) = request_id.as_deref() {
                crate::request::transition_and_emit(&self.app, request_id, next, category);
            }
        };
        // Arm first, then check the buffer: a paste delivered in between is
        // already behind the armed channel; an older one sits in the buffer.
        let rx = self.relay.arm();
        if let Some(ready) = self.relay.take_buffered_and_disarm() {
            finish(crate::request::REQUEST_COMPLETED, None);
            return Ok(ready);
        }
        tokio::select! {
            r = rx => match r {
                Ok(reply) => {
                    finish(crate::request::REQUEST_COMPLETED, None);
                    Ok(reply)
                }
                Err(_) => {
                    finish(crate::request::REQUEST_FAILED, Some("closed"));
                    Err("manual relay closed".to_string())
                }
            },
            _ = tokio::time::sleep(Duration::from_secs(600)) => {
                finish(crate::request::REQUEST_TIMED_OUT, Some("timeout"));
                Err("manual relay timed out after 10 minutes; retry the task or choose another provider".into())
            }
            _ = cancel.notified() => {
                // C5: cancel requested, then cancel completed.
                finish(crate::request::REQUEST_CANCEL_REQUESTED, None);
                finish(crate::request::REQUEST_CANCELLED, None);
                Err("stopped".into())
            }
        }
        // Liveness stays with the task until its next send (note_live) swaps
        // to the following task and clears the buffer, so a fast paste between
        // rounds is never dropped and a stale paste never leaks tasks.
    }
}

// ---------------------------------------------------------------------------
// Local model servers (Ollama :11434, LM Studio :1234 — OpenAI-compatible)
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct LocalProvider {
    /// Emission/registry target: the Tauri app in production, a recording
    /// sink + isolated registry in tests (Step 2: same lifecycle code path
    /// runs in both).
    pub target: LocalTarget,
    pub kind: LocalKind,
    pub cfg: LocalCfg,
    pub messages: Arc<Mutex<Vec<Value>>>,
    /// Correlation ID of the round currently in send/wait (Step 2). Every
    /// lifecycle event and every streaming chunk is keyed to it.
    current_request: Arc<Mutex<Option<String>>>,
}

/// Where a local provider reports lifecycle events and stream chunks.
#[derive(Clone)]
pub enum LocalTarget {
    /// Production: emits `evt` through the Tauri app and uses the shared
    /// request registry.
    App(tauri::AppHandle),
    /// Test harness: records every emitted payload verbatim and drives an
    /// isolated registry. Deterministic mock — no Tauri runtime involved.
    #[cfg(test)]
    Test {
        sink: Arc<Mutex<Vec<Value>>>,
        registry: Arc<crate::request::RequestRegistry>,
    },
}

impl LocalTarget {
    fn registry(&self) -> Arc<crate::request::RequestRegistry> {
        match self {
            LocalTarget::App(app) => crate::request::registry_of(app),
            #[cfg(test)]
            LocalTarget::Test { registry, .. } => registry.clone(),
        }
    }
    fn emit(&self, payload: Value) {
        match self {
            LocalTarget::App(app) => {
                use tauri::Emitter;
                let _ = app.emit("evt", payload);
            }
            #[cfg(test)]
            LocalTarget::Test { sink, .. } => sink.lock().unwrap().push(payload),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LocalKind {
    Ollama,
    LmStudio,
}

#[derive(Default)]
struct ByteLineDecoder {
    pending: Vec<u8>,
}

impl ByteLineDecoder {
    fn push(&mut self, chunk: &[u8]) -> Vec<Vec<u8>> {
        self.pending.extend_from_slice(chunk);
        let mut lines = Vec::new();
        let mut start = 0;
        for (index, byte) in self.pending.iter().enumerate() {
            if *byte == b'\n' {
                lines.push(self.pending[start..index].to_vec());
                start = index + 1;
            }
        }
        if start > 0 {
            self.pending.drain(..start);
        }
        lines
    }

    fn finish(&mut self) -> Option<Vec<u8>> {
        if self.pending.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.pending))
        }
    }
}

fn local_stream_content(kind: LocalKind, line: &[u8]) -> Result<Option<String>, String> {
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    if line.iter().all(u8::is_ascii_whitespace) {
        return Ok(None);
    }
    let value = match kind {
        LocalKind::Ollama => serde_json::from_slice::<Value>(line)
            .map_err(|e| format!("invalid Ollama stream line: {e}"))?,
        LocalKind::LmStudio => {
            let text = std::str::from_utf8(line)
                .map_err(|e| format!("invalid UTF-8 in LM Studio stream: {e}"))?;
            let Some(data) = text.trim().strip_prefix("data:").map(str::trim) else {
                return Ok(None);
            };
            if data.is_empty() || data == "[DONE]" {
                return Ok(None);
            }
            serde_json::from_str::<Value>(data)
                .map_err(|e| format!("invalid LM Studio stream event: {e}"))?
        }
    };
    if let Some(error) = value["error"].as_str() {
        return Err(format!("local model server stream error: {error}"));
    }
    let content = match kind {
        LocalKind::Ollama => value["message"]["content"].as_str(),
        LocalKind::LmStudio => value["choices"][0]["delta"]["content"].as_str(),
    };
    Ok(content.map(str::to_owned))
}

fn local_request_body(kind: LocalKind, model: &str, messages: &[Value], cfg: &LocalCfg) -> Value {
    match kind {
        LocalKind::Ollama => json!({
            "model": model,
            "messages": messages,
            "stream": true,
            "options": {
                "num_ctx": cfg.num_ctx.unwrap_or(8192),
                "temperature": cfg.temperature.unwrap_or(0.7)
            }
        }),
        LocalKind::LmStudio => json!({
            "model": model,
            "messages": messages,
            "stream": true,
            "temperature": cfg.temperature.unwrap_or(0.7)
        }),
    }
}

impl LocalProvider {
    pub fn new(app: tauri::AppHandle, kind: LocalKind, cfg: LocalCfg) -> Self {
        Self::with_target(LocalTarget::App(app), kind, cfg)
    }

    /// Test-only constructor: deterministic mock target with a recording
    /// sink and an isolated request registry.
    #[cfg(test)]
    pub(crate) fn new_test(
        kind: LocalKind,
        cfg: LocalCfg,
    ) -> (
        Self,
        Arc<Mutex<Vec<Value>>>,
        Arc<crate::request::RequestRegistry>,
    ) {
        let sink = Arc::new(Mutex::new(Vec::new()));
        let registry = Arc::new(crate::request::RequestRegistry::default());
        let provider = Self::with_target(
            LocalTarget::Test {
                sink: sink.clone(),
                registry: registry.clone(),
            },
            kind,
            cfg,
        );
        (provider, sink, registry)
    }

    fn with_target(target: LocalTarget, kind: LocalKind, cfg: LocalCfg) -> Self {
        LocalProvider {
            target,
            kind,
            cfg,
            messages: Arc::new(Mutex::new(Vec::new())),
            current_request: Arc::new(Mutex::new(None)),
        }
    }

    /// Stable provider identity for correlation + diagnostics.
    pub fn provider_id(&self) -> &'static str {
        match self.kind {
            LocalKind::Ollama => "ollama",
            LocalKind::LmStudio => "lmstudio",
        }
    }

    /// One validated registry transition + its metadata-only event. Invalid
    /// transitions (e.g. anything after a terminal state) are dropped.
    fn emit_state(&self, request_id: &str, next: &str, category: Option<&str>) {
        let registry = self.target.registry();
        if let Some(record) = registry.transition(request_id, next, category) {
            self.target
                .emit(crate::request::request_event_payload(&record, category));
        }
    }

    /// Register a request in the registry and emit its `created` event.
    fn begin_request(&self, request_id: &str, task_id: &str) {
        let registry = self.target.registry();
        if registry.begin(request_id, self.provider_id(), Some(task_id), None) {
            if let Some(record) = registry.snapshot_record(request_id) {
                self.target
                    .emit(crate::request::request_event_payload(&record, None));
            }
        }
    }

    pub fn describe(&self) -> String {
        format!(
            "{:?} {} [{}]",
            self.kind,
            self.cfg.url,
            self.cfg.model.clone().unwrap_or_default()
        )
    }

    fn client() -> Result<reqwest::Client, String> {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(600))
            .build()
            .map_err(|e| e.to_string())
    }

    /// Keep the context bounded: keep the preamble + the most recent window.
    fn prune_messages(&self) {
        let max_chars = self.cfg.context_chars.unwrap_or(24_000);
        let mut msgs = self.messages.lock().unwrap();
        if msgs.is_empty() {
            return;
        }
        let mut total: usize = msgs
            .iter()
            .map(|m| m["content"].as_str().map(|c| c.len()).unwrap_or(0))
            .sum();
        let mut idx = 1; // keep index 0 (preamble/system)
        while idx < msgs.len() && total > max_chars {
            total -= msgs[idx]["content"].as_str().map(|c| c.len()).unwrap_or(0);
            idx += 1;
        }
        if idx > 1 {
            msgs.drain(1..idx);
            msgs.insert(1, json!({"role": "system", "content": format!("[older context pruned to stay under {max_chars} chars]")}));
        }
    }

    /// Queue one user message. Step 2: this CREATES the request lifecycle
    /// (`created`); the HTTP POST happens in `wait_reply`, where a local
    /// runtime's submission acknowledgment is observable.
    pub async fn send(&mut self, task_id: &str, text: &str) -> Result<(), String> {
        // One correlation ID per send — same shape as the web provider. The
        // registry refuses ID reuse; all later transitions and stream chunks
        // are keyed to it.
        let request_id = format!(
            "{task_id}.{}",
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        );
        *self.current_request.lock().unwrap() = Some(request_id.clone());
        self.begin_request(&request_id, task_id);
        self.messages
            .lock()
            .unwrap()
            .push(json!({"role": "user", "content": text}));
        self.prune_messages();
        Ok(())
    }

    /// Wait for the local runtime's reply. Reports the full lifecycle:
    /// `submitting → submitted (HTTP accepted) → streaming (first chunk) →
    /// completed`, or an honest terminal failure/timeout/cancel at the point
    /// it actually happens.
    pub async fn wait_reply(&mut self, cancel: Arc<Notify>) -> Result<String, String> {
        let request_id = self
            .current_request
            .lock()
            .unwrap()
            .clone()
            .ok_or("no request in flight — nothing was sent")?;
        let fail_config = |provider: &Self, msg: String| -> String {
            provider.emit_state(&request_id, crate::request::REQUEST_FAILED, Some("config"));
            msg
        };
        let model = match self.cfg.model.clone() {
            Some(m) => m,
            None => {
                return Err(fail_config(
                    self,
                    "no model selected — pick one in Settings".into(),
                ))
            }
        };
        // Enforce the local-only network policy at the last possible point: a
        // hand-edited or corrupted settings file must never aim prompts at a
        // hosted endpoint, even if it slipped past settings validation.
        if let Err(e) = ensure_local_endpoint(&self.cfg.url) {
            return Err(fail_config(self, e));
        }
        let client = match Self::client() {
            Ok(c) => c,
            Err(e) => return Err(fail_config(self, e)),
        };
        let msgs = self.messages.lock().unwrap().clone();
        let url = match self.kind {
            LocalKind::Ollama => format!("{}/api/chat", self.cfg.url.trim_end_matches('/')),
            LocalKind::LmStudio => {
                format!("{}/chat/completions", openai_compatible_base(&self.cfg.url))
            }
        };
        self.emit_state(&request_id, crate::request::REQUEST_SUBMITTING, None);
        let (tx, mut rx) = mpsc::channel::<String>(64);
        // HTTP acknowledgment: resolved as soon as the runtime accepts the
        // POST (2xx headers), so "submission acknowledged" is distinguishable
        // from "response completed" even when the first chunk lags.
        let (ack_tx, mut ack_rx) = tokio::sync::oneshot::channel::<()>();

        let kind = self.kind;
        let body = local_request_body(kind, &model, &msgs, &self.cfg);

        let handle = tokio::spawn(async move {
            let resp = client.post(&url).json(&body).send().await.map_err(|e| {
                format!("cannot reach local server at {url} — is it running? ({e})")
            })?;
            if !resp.status().is_success() {
                return Err(format!(
                    "local server error {}: {}",
                    resp.status(),
                    resp.text().await.unwrap_or_default()
                ));
            }
            let _ = ack_tx.send(());
            let mut stream = resp.bytes_stream();
            let mut lines = ByteLineDecoder::default();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| e.to_string())?;
                for line in lines.push(&chunk) {
                    if let Some(content) = local_stream_content(kind, &line)? {
                        tx.send(content)
                            .await
                            .map_err(|_| "local response receiver closed".to_string())?;
                    }
                }
            }
            if let Some(line) = lines.finish() {
                if let Some(content) = local_stream_content(kind, &line)? {
                    tx.send(content)
                        .await
                        .map_err(|_| "local response receiver closed".to_string())?;
                }
            }
            Ok::<(), String>(())
        });

        // C6: an ABSOLUTE deadline from submission, not a per-chunk timer —
        // a steadily-streaming reply can no longer extend the timeout
        // indefinitely.
        let timeout = tokio::time::sleep(Duration::from_secs(self.cfg.timeout_secs.unwrap_or(600)));
        tokio::pin!(timeout);
        let registry = self.target.registry();
        let provider_id = self.provider_id();
        let emit_chunk = |text: String| {
            // D7: drop late chunks the moment the request stops accepting
            // them (cancel requested or terminal) — they can never pollute a
            // newer request's preview.
            if registry.is_streaming_allowed(&request_id) {
                self.target.emit(json!({
                    "kind": "assistant-stream",
                    "text": text,
                    "request_id": request_id,
                    "provider": provider_id,
                }));
            }
        };

        let mut reply = String::new();
        let mut submitted = false;
        let mut streaming = false;
        // The oneshot must be polled at most once: after it resolves (Ok or
        // Err), the guard disables the branch so a later loop pass can never
        // re-poll a completed receiver (panics with "called after complete").
        let mut ack_done = false;
        let mut last_emit = std::time::Instant::now();
        let mut pending_emit = String::new();
        loop {
            tokio::select! {
                // Deterministic ordering: when the HTTP acknowledgement and
                // the first stream event become ready together (e.g. a 2xx
                // whose body then carries an error), the ack MUST be recorded
                // before the terminal state, or the reported lifecycle would
                // randomly skip "submitted" from run to run.
                biased;
                ack = &mut ack_rx, if !ack_done => {
                    ack_done = true;
                    if ack.is_ok() {
                        submitted = true;
                        self.emit_state(&request_id, crate::request::REQUEST_SUBMITTED, None);
                    }
                }
                item = rx.recv() => {
                    match item {
                        Some(chunk) => {
                            if !submitted {
                                submitted = true;
                                self.emit_state(&request_id, crate::request::REQUEST_SUBMITTED, None);
                            }
                            if !streaming {
                                streaming = true;
                                self.emit_state(&request_id, crate::request::REQUEST_STREAMING, None);
                            }
                            reply.push_str(&chunk);
                            pending_emit.push_str(&chunk);
                            if last_emit.elapsed() > std::time::Duration::from_millis(120) {
                                emit_chunk(std::mem::take(&mut pending_emit));
                                last_emit = std::time::Instant::now();
                            }
                        }
                        None => break, // stream task finished
                    }
                }
                _ = cancel.notified() => {
                    handle.abort();
                    // C5: distinguish the cancel REQUEST from its completion.
                    self.emit_state(&request_id, crate::request::REQUEST_CANCEL_REQUESTED, None);
                    self.emit_state(&request_id, crate::request::REQUEST_CANCELLED, None);
                    return Err("stopped".into());
                }
                _ = &mut timeout => {
                    handle.abort();
                    self.emit_state(&request_id, crate::request::REQUEST_TIMED_OUT, Some("timeout"));
                    return Err("model reply timed out".into());
                }
            }
        }
        if !pending_emit.is_empty() {
            emit_chunk(std::mem::take(&mut pending_emit));
        }
        match handle.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                self.emit_state(
                    &request_id,
                    crate::request::REQUEST_FAILED,
                    Some(local_error_category(&e)),
                );
                return Err(e);
            }
            Err(e) => {
                let msg = format!("stream task: {e}");
                self.emit_state(
                    &request_id,
                    crate::request::REQUEST_FAILED,
                    Some("provider_error"),
                );
                return Err(msg);
            }
        }
        if reply.trim().is_empty() {
            self.emit_state(
                &request_id,
                crate::request::REQUEST_FAILED,
                Some("provider_error"),
            );
            return Err("empty reply from local model".into());
        }
        self.messages
            .lock()
            .unwrap()
            .push(json!({"role": "assistant", "content": reply.clone()}));
        self.emit_state(&request_id, crate::request::REQUEST_COMPLETED, None);
        Ok(reply)
    }
}

/// Coarse, non-sensitive failure category for local runtimes. Mirrors the
/// web provider's vocabulary so the UI can explain failures uniformly.
fn local_error_category(error: &str) -> &'static str {
    if error.contains("cannot reach local server") {
        "unavailable"
    } else if error.contains("local server error") {
        "send_failed"
    } else {
        "provider_error"
    }
}

/// Normalize an OpenAI-compatible endpoint base. Accept both http://host:port
/// and http://host:port/v1 without ever generating /v1/v1/... URLs.
fn openai_compatible_base(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    trimmed.strip_suffix("/v1").unwrap_or(trimmed).to_string() + "/v1"
}

/// Neelima talks ONLY to locally running inference runtimes. Every local
/// provider endpoint must resolve to this machine (loopback); hosted AI
/// endpoints are rejected before any request leaves the process.
///
/// Accepted hosts: `localhost`, `*.localhost`, `127.0.0.0/8`, `::1`, `[::1]`,
/// and `0.0.0.0` (bind-all address). Everything else — including LAN IPs and
/// any public host — fails with an actionable message.
pub fn ensure_local_endpoint(url: &str) -> Result<(), String> {
    let parsed = tauri::Url::parse(url.trim()).map_err(|_| {
        format!("'{url}' is not a valid URL — expected e.g. http://localhost:11434")
    })?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!(
            "unsupported scheme '{}' — local runtimes use http://localhost:<port>",
            parsed.scheme()
        ));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "endpoint URL has no host".to_string())?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    // 127.0.0.0/8: first octet is 127, the rest are any octets.
    let octets: Vec<Option<u8>> = host.split('.').map(|p| p.parse::<u8>().ok()).collect();
    let is_ipv4_loopback =
        octets.len() == 4 && octets[0] == Some(127) && octets[1..].iter().all(|o| o.is_some());
    let is_local = host == "localhost"
        || host.eq_ignore_ascii_case("0.0.0.0")
        || host == "::1"
        || host.to_ascii_lowercase().ends_with(".localhost")
        || is_ipv4_loopback;
    if is_local {
        Ok(())
    } else {
        Err(format!(
            "'{host}' is not a local endpoint. Neelima only talks to inference runtimes on this machine (e.g. http://localhost:11434 for Ollama, http://localhost:1234 for LM Studio). Hosted AI services are not supported."
        ))
    }
}

/// List models from a local server (GET only).
pub async fn list_models(kind: LocalKind, base_url: &str) -> Result<Vec<String>, String> {
    // Same local-only gate as chat: model discovery must never probe a
    // hosted endpoint either.
    ensure_local_endpoint(base_url)?;
    let client = LocalProvider::client()?;
    let url = match kind {
        LocalKind::Ollama => format!("{}/api/tags", base_url.trim_end_matches('/')),
        LocalKind::LmStudio => format!("{}/models", openai_compatible_base(base_url)),
    };
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|_| format!("cannot reach {url} — is the server running?"))?;
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(match kind {
        LocalKind::Ollama => v["models"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|m| m["name"].as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
        LocalKind::LmStudio => v["data"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|m| m["id"].as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
    })
}

use futures_util::StreamExt;

#[cfg(test)]
mod tests {
    use super::*;

    /// Phase 4 (local-only rule): every accepted endpoint is loopback; hosted
    /// or LAN endpoints are rejected with an actionable message, and the gate
    /// is enforced both at settings-save time and immediately before chat.
    #[test]
    fn local_endpoint_gate_accepts_only_loopback() {
        for ok in [
            "http://localhost:11434",
            "http://localhost:1234/v1",
            "http://127.0.0.1:8080",
            "http://127.9.9.9",
            "http://[::1]:1234",
            "http://0.0.0.0:1234",
            "http://proxy.localhost:8000",
        ] {
            assert!(ensure_local_endpoint(ok).is_ok(), "expected {ok} accepted");
        }
        for bad in [
            "https://api.openai.com/v1",
            "http://api.deepseek.com",
            "http://192.168.1.10:11434",
            "http://10.0.0.5:1234",
            "https://dashscope.aliyuncs.com",
            "https://generativelanguage.googleapis.com",
            "ftp://localhost",
            "not a url at all",
        ] {
            let err = ensure_local_endpoint(bad).unwrap_err();
            assert!(
                err.contains("not a local endpoint")
                    || err.contains("unsupported scheme")
                    || err.contains("not a valid URL"),
                "{bad} rejected with an actionable message, got: {err}"
            );
        }
    }

    #[test]
    fn byte_line_decoder_preserves_split_utf8_sequences() {
        let wire = b"data: {\"choices\":[{\"delta\":{\"content\":\"caf\xc3\xa9\"}}]}\r\n";
        let split = wire.iter().position(|byte| *byte == 0xc3).unwrap() + 1;
        let mut decoder = ByteLineDecoder::default();
        assert!(decoder.push(&wire[..split]).is_empty());
        let lines = decoder.push(&wire[split..]);
        assert_eq!(lines.len(), 1);
        assert_eq!(
            local_stream_content(LocalKind::LmStudio, &lines[0]).unwrap(),
            Some("café".into())
        );
        assert!(decoder.finish().is_none());
    }

    #[test]
    fn stream_decoder_handles_multiple_and_unterminated_lines() {
        let mut decoder = ByteLineDecoder::default();
        let lines =
            decoder.push(b"{\"message\":{\"content\":\"one\"}}\n{\"message\":{\"content\":\"two");
        assert_eq!(
            local_stream_content(LocalKind::Ollama, &lines[0]).unwrap(),
            Some("one".into())
        );
        let lines = decoder.push(b"\"}}\n{\"message\":{\"content\":\"tail\"}}");
        assert_eq!(
            local_stream_content(LocalKind::Ollama, &lines[0]).unwrap(),
            Some("two".into())
        );
        let final_line = decoder.finish().unwrap();
        assert_eq!(
            local_stream_content(LocalKind::Ollama, &final_line).unwrap(),
            Some("tail".into())
        );
    }

    #[test]
    fn ollama_request_includes_configured_context_and_temperature() {
        let cfg = LocalCfg {
            url: "http://localhost:11434".into(),
            model: Some("test".into()),
            context_chars: None,
            temperature: Some(0.25),
            num_ctx: Some(16_384),
            timeout_secs: None,
        };
        let body = local_request_body(LocalKind::Ollama, "test", &[], &cfg);
        assert_eq!(body["options"]["num_ctx"], 16_384);
        assert_eq!(body["options"]["temperature"], 0.25);
        assert_eq!(body["stream"], true);
    }

    /// Fast-paste race: a reply delivered before wait_reply arms the channel
    /// is buffered, never dropped, and the next wait returns it.
    #[test]
    fn manual_relay_slot_race_semantics() {
        let relay = Arc::new(RelaySlot::default());
        // No live task: deliver must fail (historic "no manual relay waiting").
        assert!(!relay.deliver("orphan".into()));
        // Task goes live; no waiter armed yet: fast paste must be buffered.
        relay.note_live("task-1");
        assert!(relay.deliver("fast paste".into()));
        // Arm-then-check: the buffered reply comes straight out of the wait.
        let rx = relay.arm();
        let buffered = relay.take_buffered_and_disarm();
        assert_eq!(buffered.as_deref(), Some("fast paste"));
        // The armed receiver stays unusable (disarmed) — it must not deliver a
        // second reply later.
        assert!(relay.take_buffered_and_disarm().is_none());
        drop(rx);
        // Direct delivery when armed takes the channel path, not the buffer.
        let rx = relay.arm();
        assert!(relay.deliver("inline paste".into()));
        assert_eq!(
            tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(rx)
                .unwrap(),
            "inline paste"
        );
        assert!(
            relay.take_buffered_and_disarm().is_none(),
            "no double delivery"
        );
    }

    #[test]
    fn manual_relay_new_task_clears_stale_buffer() {
        let relay = Arc::new(RelaySlot::default());
        relay.note_live("task-1");
        assert!(relay.deliver("stale".into()));
        // A NEW task's first send resets the buffer; the stale paste is gone.
        relay.note_live("task-2");
        assert!(relay.take_buffered_and_disarm().is_none());
    }

    #[test]
    fn openai_compatible_base_normalizes_v1_suffix() {
        for input in [
            "http://localhost:1234",
            "http://localhost:1234/",
            "http://localhost:1234/v1",
            "http://localhost:1234/v1/",
        ] {
            assert_eq!(
                openai_compatible_base(input),
                "http://localhost:1234/v1",
                "input: {input}"
            );
        }
    }

    // -----------------------------------------------------------------------
    // Step 2 (J): local provider request lifecycle against a MOCKED local
    // inference server. Deterministic tokio TCP listener on loopback; these
    // tests drive the REAL send/wait_reply path (the same code the app runs)
    // through the recording-target harness with an isolated request registry.
    // They are NOT live Ollama/LM Studio runs and are labelled as mocks.
    // -----------------------------------------------------------------------

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const HEAD_NO_LENGTH: &str = "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\n\r\n";

    /// Mocked local runtime: accepts ONE connection, reads the request,
    /// writes the canned head + body parts, optionally holding the connection
    /// open so the client's stream never ends on its own.
    async fn spawn_mock_server(
        head: &str,
        parts: Vec<Vec<u8>>,
        part_delay_ms: u64,
        keep_open: bool,
    ) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let head = head.to_string();
        tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = vec![0u8; 1 << 16];
                let _ = sock.read(&mut buf).await;
                if !head.is_empty() {
                    let _ = sock.write_all(head.as_bytes()).await;
                    let _ = sock.flush().await;
                }
                for part in parts {
                    if part_delay_ms > 0 {
                        tokio::time::sleep(Duration::from_millis(part_delay_ms)).await;
                    }
                    let _ = sock.write_all(&part).await;
                    let _ = sock.flush().await;
                }
                if keep_open {
                    loop {
                        tokio::time::sleep(Duration::from_secs(3600)).await;
                    }
                }
                let _ = sock.shutdown().await;
            }
        });
        format!("http://{addr}")
    }

    fn ollama_cfg(url: &str, timeout_secs: u64) -> LocalCfg {
        LocalCfg {
            url: url.into(),
            model: Some("test-model".into()),
            context_chars: None,
            temperature: None,
            num_ctx: None,
            timeout_secs: Some(timeout_secs),
        }
    }

    /// Lifecycle states recorded in the sink, in order (events only).
    fn states_of(sink: &Arc<Mutex<Vec<Value>>>) -> Vec<String> {
        sink.lock()
            .unwrap()
            .iter()
            .filter(|p| p["kind"] == "provider-request-state")
            .filter_map(|p| p["state"].as_str().map(str::to_owned))
            .collect()
    }

    /// J3: the full local happy path — created → submitting → submitted (HTTP
    /// accepted) → streaming (first chunk) → completed, with correlated
    /// stream chunks and exactly one terminal outcome.
    #[tokio::test]
    async fn local_lifecycle_success_ollama_reports_full_contract() {
        let url = spawn_mock_server(
            HEAD_NO_LENGTH,
            vec![
                b"{\"message\":{\"content\":\"Hello\"}}\n".to_vec(),
                b"{\"message\":{\"content\":\" world\"},\"done\":true}\n".to_vec(),
            ],
            20,
            false,
        )
        .await;
        let (mut provider, sink, registry) =
            LocalProvider::new_test(LocalKind::Ollama, ollama_cfg(&url, 30));
        provider.send("t1", "hi").await.unwrap();
        assert_eq!(states_of(&sink), vec!["created"]);
        let reply = provider.wait_reply(Arc::new(Notify::new())).await.unwrap();
        assert_eq!(reply, "Hello world");
        assert_eq!(
            states_of(&sink),
            vec![
                "created",
                "submitting",
                "submitted",
                "streaming",
                "completed"
            ],
            "full local contract with exactly one terminal state"
        );
        let rid = provider.current_request.lock().unwrap().clone().unwrap();
        let sink = sink.lock().unwrap();
        let chunks: Vec<_> = sink
            .iter()
            .filter(|p| p["kind"] == "assistant-stream")
            .collect();
        assert!(!chunks.is_empty(), "stream chunks were emitted");
        for chunk in chunks {
            assert_eq!(chunk["request_id"], rid, "chunks carry the request ID");
            assert_eq!(chunk["provider"], "ollama", "chunks carry the provider");
        }
        drop(sink);
        assert_eq!(registry.status_of(&rid).as_deref(), Some("completed"));
        assert_eq!(
            provider.messages.lock().unwrap().len(),
            2,
            "the round is recorded in the task-scoped conversation"
        );
    }

    /// J3/J15: the OpenAI-compatible (LM Studio) path uses the same contract.
    #[tokio::test]
    async fn local_lifecycle_success_lmstudio_sse() {
        let url = spawn_mock_server(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n",
            vec![
                b"data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n".to_vec(),
                b"data: [DONE]\n".to_vec(),
            ],
            10,
            false,
        )
        .await;
        let (mut provider, sink, registry) =
            LocalProvider::new_test(LocalKind::LmStudio, ollama_cfg(&url, 30));
        provider.send("t1", "hi").await.unwrap();
        let reply = provider.wait_reply(Arc::new(Notify::new())).await.unwrap();
        assert_eq!(reply, "Hi");
        assert_eq!(
            states_of(&sink),
            vec![
                "created",
                "submitting",
                "submitted",
                "streaming",
                "completed"
            ]
        );
        let rid = provider.current_request.lock().unwrap().clone().unwrap();
        assert_eq!(registry.status_of(&rid).as_deref(), Some("completed"));
    }

    /// J4/J15: an unreachable local runtime fails promptly with an honest,
    /// coarse category — never a silent wait.
    #[tokio::test]
    async fn local_unreachable_runtime_fails_as_unavailable() {
        let url = {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            drop(listener);
            format!("http://{addr}")
        };
        let (mut provider, sink, registry) =
            LocalProvider::new_test(LocalKind::Ollama, ollama_cfg(&url, 30));
        provider.send("t1", "hi").await.unwrap();
        let err = provider
            .wait_reply(Arc::new(Notify::new()))
            .await
            .unwrap_err();
        assert!(err.contains("cannot reach local server"), "got: {err}");
        assert_eq!(states_of(&sink), vec!["created", "submitting", "failed"]);
        let rid = provider.current_request.lock().unwrap().clone().unwrap();
        let record = registry.snapshot_record(&rid).unwrap();
        assert_eq!(record.status, "failed");
        assert_eq!(record.error_category.as_deref(), Some("unavailable"));
    }

    /// J4: an HTTP error from the runtime is a send failure, not a timeout.
    #[tokio::test]
    async fn local_http_500_fails_as_send_failed() {
        let url = spawn_mock_server(
            "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 5\r\n\r\n",
            vec![b"boom!".to_vec()],
            0,
            false,
        )
        .await;
        let (mut provider, sink, registry) =
            LocalProvider::new_test(LocalKind::Ollama, ollama_cfg(&url, 30));
        provider.send("t1", "hi").await.unwrap();
        let err = provider
            .wait_reply(Arc::new(Notify::new()))
            .await
            .unwrap_err();
        assert!(err.contains("local server error 500"), "got: {err}");
        assert_eq!(states_of(&sink), vec!["created", "submitting", "failed"]);
        let rid = provider.current_request.lock().unwrap().clone().unwrap();
        assert_eq!(
            registry
                .snapshot_record(&rid)
                .unwrap()
                .error_category
                .as_deref(),
            Some("send_failed")
        );
    }

    /// J4/J16: a mid-stream provider-side error fails the request with a
    /// provider_error category instead of running to the deadline.
    #[tokio::test]
    async fn local_stream_error_fails_as_provider_error() {
        let url = spawn_mock_server(
            HEAD_NO_LENGTH,
            vec![b"{\"error\":\"model exploded\"}\n".to_vec()],
            0,
            false,
        )
        .await;
        let (mut provider, sink, registry) =
            LocalProvider::new_test(LocalKind::Ollama, ollama_cfg(&url, 30));
        provider.send("t1", "hi").await.unwrap();
        let err = provider
            .wait_reply(Arc::new(Notify::new()))
            .await
            .unwrap_err();
        assert!(err.contains("model exploded"), "got: {err}");
        // The runtime acknowledged the POST before the stream contained its
        // error payload, so the truthful sequence records that submission
        // was accepted and only then failed (C4: acknowledgement is not
        // completion, and it is not an error either).
        assert_eq!(
            states_of(&sink),
            vec!["created", "submitting", "submitted", "failed"]
        );
        let rid = provider.current_request.lock().unwrap().clone().unwrap();
        assert_eq!(
            registry
                .snapshot_record(&rid)
                .unwrap()
                .error_category
                .as_deref(),
            Some("provider_error")
        );
    }

    /// J6/C5: a cancel reports `cancel_requested` then `cancelled`, and no
    /// stream chunk is delivered after the cancel was requested.
    #[tokio::test]
    async fn local_cancel_reports_cancel_requested_then_cancelled() {
        let url = spawn_mock_server(
            HEAD_NO_LENGTH,
            vec![b"{\"message\":{\"content\":\"slow\"}}\n".to_vec()],
            2_000,
            true,
        )
        .await;
        let (mut provider, sink, _registry) =
            LocalProvider::new_test(LocalKind::Ollama, ollama_cfg(&url, 30));
        provider.send("t1", "hi").await.unwrap();
        let rid = provider.current_request.lock().unwrap().clone().unwrap();
        let cancel = Arc::new(Notify::new());
        let waiter = tokio::spawn({
            let cancel = cancel.clone();
            async move { provider.wait_reply(cancel).await }
        });
        // Let the POST land (submitted) before cancelling.
        tokio::time::sleep(Duration::from_millis(400)).await;
        cancel.notify_one();
        let err = waiter.await.unwrap().unwrap_err();
        assert_eq!(err, "stopped");
        assert_eq!(
            states_of(&sink),
            vec![
                "created",
                "submitting",
                "submitted",
                "cancel_requested",
                "cancelled"
            ],
            "cancel request and cancel completion are distinguishable"
        );
        let sink = sink.lock().unwrap();
        assert!(
            !sink.iter().any(|p| p["kind"] == "assistant-stream"),
            "no chunk is delivered after a cancel was requested"
        );
        drop(sink);
        assert_eq!(
            _registry.status_of(&rid).as_deref(),
            Some("cancelled"),
            "the registry's final state for the cancelled request"
        );
    }

    /// J5/G: an absolute deadline fires as timed_out with a timeout category.
    #[tokio::test]
    async fn local_timeout_reports_timed_out() {
        // Headers arrive, the runtime accepts the POST, then silence.
        let url = spawn_mock_server(HEAD_NO_LENGTH, vec![], 0, true).await;
        let (mut provider, sink, registry) =
            LocalProvider::new_test(LocalKind::Ollama, ollama_cfg(&url, 1));
        provider.send("t1", "hi").await.unwrap();
        let err = provider
            .wait_reply(Arc::new(Notify::new()))
            .await
            .unwrap_err();
        assert!(err.contains("timed out"), "got: {err}");
        assert_eq!(
            states_of(&sink),
            vec!["created", "submitting", "submitted", "timed_out"]
        );
        let rid = provider.current_request.lock().unwrap().clone().unwrap();
        let record = registry.snapshot_record(&rid).unwrap();
        assert_eq!(record.status, "timed_out");
        assert_eq!(record.error_category.as_deref(), Some("timeout"));
    }

    /// J7: re-waiting without a new send cannot produce a second terminal
    /// outcome — the registry suppresses it.
    #[tokio::test]
    async fn a_second_wait_emits_no_second_terminal() {
        let url = spawn_mock_server(
            HEAD_NO_LENGTH,
            vec![b"{\"message\":{\"content\":\"ok\"}}\n".to_vec()],
            0,
            false,
        )
        .await;
        let (mut provider, sink, registry) =
            LocalProvider::new_test(LocalKind::Ollama, ollama_cfg(&url, 30));
        provider.send("t1", "hi").await.unwrap();
        provider.wait_reply(Arc::new(Notify::new())).await.unwrap();
        let rid = provider.current_request.lock().unwrap().clone().unwrap();
        let states_before = states_of(&sink);
        assert_eq!(states_before.last().unwrap(), "completed");
        // The mock server is gone; the re-wait errors, but its failure can
        // never repaint the completed request.
        let _ = provider.wait_reply(Arc::new(Notify::new())).await;
        assert_eq!(states_of(&sink), states_before, "no new lifecycle events");
        assert_eq!(registry.status_of(&rid).as_deref(), Some("completed"));
    }

    /// G: a missing model is a config failure at wait time, reported honestly.
    #[tokio::test]
    async fn local_missing_model_fails_as_config() {
        let cfg = LocalCfg {
            url: "http://127.0.0.1:9".into(),
            model: None,
            context_chars: None,
            temperature: None,
            num_ctx: None,
            timeout_secs: None,
        };
        let (mut provider, sink, _registry) = LocalProvider::new_test(LocalKind::Ollama, cfg);
        provider.send("t1", "hi").await.unwrap();
        let err = provider
            .wait_reply(Arc::new(Notify::new()))
            .await
            .unwrap_err();
        assert!(err.contains("no model selected"), "got: {err}");
        assert_eq!(states_of(&sink), vec!["created", "failed"]);
        let rid = provider.current_request.lock().unwrap().clone().unwrap();
        assert_eq!(
            _registry
                .snapshot_record(&rid)
                .unwrap()
                .error_category
                .as_deref(),
            Some("config")
        );
    }
}
