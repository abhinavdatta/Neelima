//! The narrow provider bridge: ONE command (`lb_bridge`) reachable from the
//! provider webview, granted via a capability that contains nothing else.
//! Messages are small, typed, size-capped. Nothing else on this page can reach
//! any other app command (app ACL manifest), and every other command also
//! label-checks its caller as defense in depth.
//!
//! The provider webview can initiate three file operations (read_file,
//! write_file, list_dir) through a `file_op` message type. These are routed to
//! the app's confined tool executor and scoped to the currently open workspace
//! — the provider chat page itself never touches the local filesystem.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde_json::Value;
use tauri::{Manager, State};
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

/// One file operation initiated from the provider webview.
#[derive(serde::Deserialize)]
#[serde(tag = "op", content = "args")]
enum FileOp {
    ReadFile { path: String, offset: Option<usize>, limit: Option<usize> },
    WriteFile { path: String, content: String, append: Option<bool> },
    ListDir { path: Option<String> },
}

/// Execute a file operation inside the currently open workspace (if any).
fn do_file_op(app: &tauri::AppHandle, op: FileOp) -> Result<Value, String> {
    let slot: tauri::State<'_, crate::ui::WorkspaceSlot> = app.state();
    let ws = slot
        .0
        .lock()
        .unwrap()
        .clone()
        .ok_or("no workspace open — pick a folder first")?;

    match op {
        FileOp::ReadFile { path, offset, limit } => {
            let args = serde_json::json!({
                "path": path,
                "offset": offset,
                "limit": limit,
            });
            let out = crate::tools::read_file(&ws, &args, 64 * 1024);
            Ok(serde_json::json!({
                "ok": out.ok,
                "output": out.output,
            }))
        }
        FileOp::WriteFile { path, content, append } => {
            let args = serde_json::json!({
                "path": path,
                "content": content,
                "append": append,
            });
            let out = crate::tools::write_file(&ws, &args);
            Ok(serde_json::json!({
                "ok": out.ok,
                "output": out.output,
            }))
        }
        FileOp::ListDir { path } => {
            let rel = path.as_deref().unwrap_or(".");
            let args = serde_json::json!({ "path": rel });
            let out = crate::tools::list_dir(&ws, &args);
            Ok(serde_json::json!({
                "ok": out.ok,
                "output": out.output,
            }))
        }
    }
}

/// The single intake command. Keep it boring: parse, validate, route.
/// Returns the result value directly so the caller can `await` it.
#[tauri::command]
pub async fn lb_bridge(
    webview: tauri::Webview,
    hub: State<'_, BridgeHub>,
    msg: String,
) -> Result<Value, String> {
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
        "hello" | "event" => Ok(Value::Null),
        "rpc_result" => {
            let id = parsed.id.ok_or("lb_bridge: rpc_result missing id")?;
            let raw = parsed.v.as_deref().unwrap_or("null");
            let value: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
            hub.resolve(&id, value);
            Ok(Value::Null)
        }
        "file_op" => {
            let op: FileOp = serde_json::from_str(parsed.v.as_deref().unwrap_or("{}"))
                .map_err(|e| format!("lb_bridge: bad file_op: {e}"))?;
            let app = webview.app_handle().clone();
            do_file_op(&app, op)
        }
        other => Err(format!("lb_bridge: unknown message type '{other}'")),
    }
}
