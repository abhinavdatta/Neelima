//! Provider abstraction + local model clients (Ollama, LM Studio) + manual relay.
//!
//! The ONLY network destinations allowed anywhere in Neelima are localhost
//! (these two clients) and the pages loaded inside the provider webview.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, Notify};

use crate::settings::LocalProvider as LocalCfg;

#[derive(Clone)]
pub enum Provider {
    /// Embedded provider web chat, driven through the adapter runtime.
    Web(crate::webprov::WebProvider),
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

    /// Send a message. `task_id` identifies the task (the web provider uses it
    /// to decide new_chat), `first_of_task` allows the web provider to reset
    /// the chat exactly once per task (A8).
    pub async fn send(&mut self, task_id: &str, text: &str, first_of_task: bool) -> Result<(), String> {
        match self {
            Provider::Web(w) => w.send(task_id, text, first_of_task).await,
            Provider::Local(l) => l.send(text).await,
            Provider::Manual(m) => m.send(text).await,
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
/// waiting. Managed as Arc<RelaySlot>.
#[derive(Default)]
pub struct RelaySlot(pub Mutex<Option<oneshot::Sender<String>>>);

impl RelaySlot {
    pub fn deliver(&self, text: String) -> bool {
        if let Some(tx) = self.0.lock().unwrap().take() {
            let _ = tx.send(text);
            true
        } else {
            false
        }
    }
}

#[derive(Clone)]
pub struct ManualProvider {
    pub app: tauri::AppHandle,
    pub relay: Arc<RelaySlot>,
}

impl ManualProvider {
    pub fn new(app: tauri::AppHandle, relay: Arc<RelaySlot>) -> Self {
        ManualProvider { app, relay }
    }

    pub async fn send(&mut self, text: &str) -> Result<(), String> {
        use tauri::Emitter;
        let _ = self.app.emit("evt", json!({"kind": "relay-outbound", "text": text}));
        Ok(())
    }

    pub async fn wait_reply(&mut self, cancel: Arc<Notify>) -> Result<String, String> {
        let (tx, rx) = oneshot::channel();
        *self.relay.0.lock().unwrap() = Some(tx);
        tokio::select! {
            r = rx => r.map_err(|_| "manual relay closed".to_string()),
            _ = cancel.notified() => Err("stopped".into()),
        }
    }
}

// ---------------------------------------------------------------------------
// Local model servers (Ollama :11434, LM Studio :1234 — OpenAI-compatible)
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct LocalProvider {
    pub app: tauri::AppHandle,
    pub kind: LocalKind,
    pub cfg: LocalCfg,
    pub messages: Arc<Mutex<Vec<Value>>>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LocalKind {
    Ollama,
    LmStudio,
}

impl LocalProvider {
    pub fn new(app: tauri::AppHandle, kind: LocalKind, cfg: LocalCfg) -> Self {
        LocalProvider { app, kind, cfg, messages: Arc::new(Mutex::new(Vec::new())) }
    }

    pub fn describe(&self) -> String {
        format!("{:?} {} [{}]", self.kind, self.cfg.url, self.cfg.model.clone().unwrap_or_default())
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
        if msgs.is_empty() { return; }
        let mut total: usize = msgs.iter().map(|m| m["content"].as_str().map(|c| c.len()).unwrap_or(0)).sum();
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

    pub async fn send(&mut self, text: &str) -> Result<(), String> {
        self.messages.lock().unwrap().push(json!({"role": "user", "content": text}));
        self.prune_messages();
        Ok(())
    }

    pub async fn wait_reply(&mut self, cancel: Arc<Notify>) -> Result<String, String> {
        let model = self.cfg.model.clone().ok_or("no model selected — pick one in Settings")?;
        let client = Self::client()?;
        let msgs = self.messages.lock().unwrap().clone();
        let url = match self.kind {
            LocalKind::Ollama => format!("{}/api/chat", self.cfg.url.trim_end_matches('/')),
            LocalKind::LmStudio => format!("{}/v1/chat/completions", self.cfg.url.trim_end_matches('/')),
        };
        let (tx, mut rx) = mpsc::channel::<String>(64);
        let emit_app = self.app.clone();

        let kind = self.kind;
        let body = match kind {
            LocalKind::Ollama => json!({"model": model, "messages": msgs, "stream": true}),
            LocalKind::LmStudio => json!({"model": model, "messages": msgs, "stream": true, "temperature": self.cfg.temperature.unwrap_or(0.7)}),
        };

        let handle = tokio::spawn(async move {
            let resp = client.post(&url).json(&body).send().await.map_err(|e| {
                format!("cannot reach local server at {url} — is it running? ({e})")
            })?;
            if !resp.status().is_success() {
                return Err(format!("local server error {}: {}", resp.status(), resp.text().await.unwrap_or_default()));
            }
            let mut stream = resp.bytes_stream();
            let mut sse_buf = String::new();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| e.to_string())?;
                let text = String::from_utf8_lossy(&chunk);
                match kind {
                    LocalKind::Ollama => {
                        // NDJSON: one JSON object per line with {message:{content}}
                        for line in text.lines() {
                            if line.trim().is_empty() { continue; }
                            if let Ok(v) = serde_json::from_str::<Value>(line) {
                                if let Some(c) = v["message"]["content"].as_str() {
                                    let _ = tx.send(c.to_string()).await;
                                }
                            }
                        }
                    }
                    LocalKind::LmStudio => {
                        // SSE: data: {choices:[{delta:{content}}]}
                        sse_buf.push_str(&text);
                        while let Some(pos) = sse_buf.find('\n') {
                            let line: String = sse_buf.drain(..=pos).collect();
                            let line = line.trim();
                            let data = line.strip_prefix("data:").map(|d| d.trim()).unwrap_or("");
                            if data.is_empty() || data == "[DONE]" { continue; }
                            if let Ok(v) = serde_json::from_str::<Value>(data) {
                                if let Some(c) = v["choices"][0]["delta"]["content"].as_str() {
                                    let _ = tx.send(c.to_string()).await;
                                }
                            }
                        }
                    }
                }
            }
            Ok::<(), String>(())
        });

        let mut reply = String::new();
        let mut last_emit = std::time::Instant::now();
        loop {
            tokio::select! {
                item = rx.recv() => {
                    match item {
                        Some(chunk) => {
                            reply.push_str(&chunk);
                            if last_emit.elapsed() > std::time::Duration::from_millis(120) {
                                use tauri::Emitter;
                                let _ = emit_app.emit("evt", json!({"kind": "assistant-stream", "text": chunk}));
                                last_emit = std::time::Instant::now();
                            }
                        }
                        None => break, // stream task finished
                    }
                }
                _ = cancel.notified() => {
                    handle.abort();
                    return Err("stopped".into());
                }
                _ = tokio::time::sleep(std::time::Duration::from_secs(600)) => {
                    handle.abort();
                    return Err("model reply timed out".into());
                }
            }
        }
        match handle.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(e),
            Err(e) => return Err(format!("stream task: {e}")),
        }
        if reply.trim().is_empty() {
            return Err("empty reply from local model".into());
        }
        self.messages.lock().unwrap().push(json!({"role": "assistant", "content": reply}));
        Ok(reply)
    }
}

use futures_util::StreamExt;

/// List models from a local server (GET only).
pub async fn list_models(kind: LocalKind, base_url: &str) -> Result<Vec<String>, String> {
    let client = LocalProvider::client()?;
    let url = match kind {
        LocalKind::Ollama => format!("{}/api/tags", base_url.trim_end_matches('/')),
        LocalKind::LmStudio => format!("{}/v1/models", base_url.trim_end_matches('/')),
    };
    let resp = client.get(&url).send().await
        .map_err(|_| format!("cannot reach {url} — is the server running?"))?;
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(match kind {
        LocalKind::Ollama => v["models"].as_array().map(|a| a.iter().filter_map(|m| m["name"].as_str().map(String::from)).collect()).unwrap_or_default(),
        LocalKind::LmStudio => v["data"].as_array().map(|a| a.iter().filter_map(|m| m["id"].as_str().map(String::from)).collect()).unwrap_or_default(),
    })
}
