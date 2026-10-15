//! The narrow provider bridge: ONE command (`lb_bridge`) reachable from the
//! provider webview, granted via a capability that contains nothing else.
//! Messages are small, typed, size-capped. Nothing else on this page can reach
//! any other app command (app ACL manifest), and every other command also
//! label-checks its caller as defense in depth.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde_json::Value;
use tauri::State;
use tokio::sync::oneshot;

pub const MAX_BRIDGE_MSG: usize = 512 * 1024;

static SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct BridgeHub {
    pub pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
}

impl BridgeHub {
    /// Register a pending RPC and return its id. Caller evals
    /// `window.__LB__.call(method, argJson, id)` afterwards.
    pub fn begin(&self) -> (String, oneshot::Receiver<Value>) {
        let id = format!("r{}", SEQ.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        (id, rx)
    }

    pub fn resolve(&self, id: &str, value: Value) {
        if let Some(tx) = self.pending.lock().unwrap().remove(id) {
            let _ = tx.send(value);
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
    v: Option<String>,
}

/// The single intake command. Keep it boring: parse, validate, route.
#[tauri::command]
pub fn lb_bridge(
    webview: tauri::Webview,
    hub: State<'_, BridgeHub>,
    msg: String,
) -> Result<(), String> {
    // The provider webview is the only page that should ever call this, but the
    // ui webview's injected bridge also posts "hello" from local pages. Only
    // accept the known labels; anything else is noise.
    let label = webview.label().to_string();
    if label != "provider" && label != "ui" {
        return Err(format!("lb_bridge: unexpected caller webview '{label}'"));
    }
    if msg.len() > MAX_BRIDGE_MSG {
        return Err(format!("lb_bridge: message exceeds {} bytes", MAX_BRIDGE_MSG));
    }
    let parsed: BridgeMsg = serde_json::from_str(&msg).map_err(|e| format!("lb_bridge: bad message: {e}"))?;
    match parsed.t.as_str() {
        // The adapter runtime reporting in / one-way notifications are ignored;
        // everything interesting flows through rpc_result with an id.
        "hello" | "event" => Ok(()),
        "rpc_result" => {
            let id = parsed.id.ok_or("lb_bridge: rpc_result missing id")?;
            let raw = parsed.v.as_deref().unwrap_or("null");
            let value: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
            hub.resolve(&id, value);
            Ok(())
        }
        other => Err(format!("lb_bridge: unknown message type '{other}'")),
    }
}
