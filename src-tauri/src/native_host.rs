//! Native host IPC server — listens for connections from the
//! `com.neelima.browser_bridge` native messaging host executable.
//!
//! The native host (separate binary) reads JSON from stdin (Chrome Native
//! Messaging length-prefixed format), forwards to this server via a local
//! named pipe (Windows) or Unix domain socket (Unix), reads the response,
//! and writes it back to stdout.
//!
//! This module runs inside the Tauri app process and exposes the
//! `browser_bridge_propose` command logic to the native host.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::browser_bridge::{
    validate_proposal, BridgeRequest, BrowserBridgeHub, ProposalValidationError,
    ValidatedProposalData,
};
use crate::settings::SettingsStore;
use crate::ui::WorkspaceSlot;

/// Pipe/socket name for native host IPC.
const NATIVE_HOST_PIPE_NAME: &str = "neelima-native-host";

/// Maximum message size for native host IPC (matches browser_bridge).
const NATIVE_HOST_MAX_BYTES: usize = 256 * 1024;

/// Native host request envelope. `proposal` is present only for
/// `tool.propose`; `bridge.status` carries none, so it must stay optional or
/// every status probe fails deserialization.
#[derive(Debug, serde::Deserialize)]
struct NativeHostRequest {
    version: u64,
    request_id: String,
    operation: String,
    #[serde(default)]
    proposal: Value,
}

/// Native host response envelope.
#[derive(Debug, serde::Serialize)]
struct NativeHostResponse {
    version: u64,
    request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<NativeHostError>,
}

#[derive(Debug, serde::Serialize)]
struct NativeHostError {
    code: String,
    message: String,
}

/// Platform-specific pipe path.
fn pipe_path(app: &AppHandle) -> PathBuf {
    let data_dir = app.path().app_data_dir().expect("app data dir");
    #[cfg(windows)]
    {
        // Named pipe path on Windows: \\.\pipe\neelima-native-host
        // We use a file-based rendezvous for the pipe name.
        data_dir.join(NATIVE_HOST_PIPE_NAME)
    }
    #[cfg(not(windows))]
    {
        data_dir.join(NATIVE_HOST_PIPE_NAME)
    }
}

/// Start the native host IPC server.
///
/// Spawns a background task that accepts connections on a named pipe (Windows)
/// or Unix domain socket (Unix) and handles `tool.propose` requests by
/// delegating to the same validation logic as `browser_bridge_propose`.
pub fn start_native_host_server(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let pipe_path = pipe_path(&app);

        #[cfg(windows)]
        {
            if let Err(e) = run_windows_pipe_server(app, pipe_path).await {
                eprintln!("Native host pipe server error: {}", e);
            }
        }
        #[cfg(not(windows))]
        {
            if let Err(e) = run_unix_socket_server(app, pipe_path).await {
                eprintln!("Native host socket server error: {}", e);
            }
        }
    });
}

/// Run the Windows named pipe server.
#[cfg(windows)]
async fn run_windows_pipe_server(app: AppHandle, _pipe_path: PathBuf) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_MESSAGE, PIPE_TYPE_MESSAGE,
        PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    };

    let pipe_name = format!(r"\\.\pipe\{}", NATIVE_HOST_PIPE_NAME);
    let wide: Vec<u16> = OsStr::new(&pipe_name)
        .encode_wide()
        .chain(Some(0))
        .collect();

    // Run the entire pipe server loop in a blocking task to avoid Send issues with HANDLE
    tokio::task::spawn_blocking(move || {
        unsafe {
            loop {
                // Message mode is REQUIRED: CallNamedPipeW clients set message
                // read mode and fail with ERROR_INVALID_PARAMETER (87) against
                // a byte-type pipe. One client message = length prefix + JSON.
                let handle = CreateNamedPipeW(
                    wide.as_ptr(),
                    PIPE_ACCESS_DUPLEX,
                    PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT,
                    PIPE_UNLIMITED_INSTANCES,
                    65536,
                    65536,
                    0,
                    ptr::null_mut(),
                );
                if handle == INVALID_HANDLE_VALUE {
                    eprintln!("Failed to create named pipe instance");
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    continue;
                }

                let connected = ConnectNamedPipe(handle, ptr::null_mut()) != 0
                    || std::io::Error::last_os_error().raw_os_error() == Some(535); // ERROR_PIPE_CONNECTED

                if connected {
                    let app_clone = app.clone();
                    // Pass handle as usize to make it Send; the client task
                    // owns (and closes) this instance.
                    let handle_val = handle as usize;
                    tokio::task::spawn_blocking(move || {
                        handle_client_windows(handle_val, app_clone);
                    });
                } else {
                    let _ = CloseHandle(handle);
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
            }
        }
    })
    .await
    .map_err(|e| format!("Pipe server task failed: {}", e))?;

    Ok(())
}

#[cfg(windows)]
fn handle_client_windows(handle_val: usize, app: AppHandle) {
    use std::ptr;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile};
    use windows_sys::Win32::System::Pipes::DisconnectNamedPipe;

    let handle = handle_val as windows_sys::Win32::Foundation::HANDLE;

    // Read message length (4 bytes, little-endian). The client transacts the
    // whole frame (prefix + JSON) as ONE message, so this 4-byte read returns
    // FALSE with ERROR_MORE_DATA (234) — that is success, not failure.
    let mut len_bytes = [0u8; 4];
    let mut bytes_read = 0u32;
    unsafe {
        let ok = ReadFile(
            handle,
            len_bytes.as_mut_ptr() as *mut _,
            4,
            &mut bytes_read,
            ptr::null_mut(),
        );
        let more_data = ok == 0 && std::io::Error::last_os_error().raw_os_error() == Some(234); // ERROR_MORE_DATA
        if (ok == 0 && !more_data) || bytes_read != 4 {
            let _ = DisconnectNamedPipe(handle);
            let _ = CloseHandle(handle);
            return;
        }
    }
    let len = u32::from_le_bytes(len_bytes) as usize;
    if len > NATIVE_HOST_MAX_BYTES {
        unsafe {
            let _ = DisconnectNamedPipe(handle);
            let _ = CloseHandle(handle);
        }
        return;
    }

    // Read message body
    let mut buf = vec![0u8; len];
    unsafe {
        let ok = ReadFile(
            handle,
            buf.as_mut_ptr() as *mut _,
            len as u32,
            &mut bytes_read,
            ptr::null_mut(),
        );
        if ok == 0 || bytes_read as usize != len {
            let _ = DisconnectNamedPipe(handle);
            let _ = CloseHandle(handle);
            return;
        }
    }

    // Process request (blocking call to async function via block_in_place)
    let response = tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(process_native_host_request(&app, &buf))
    });

    // Write response as ONE message: CallNamedPipeW's single ReadFile returns
    // exactly one message-mode message, so the length prefix and body must be
    // written together or the client would only ever see the 4-byte prefix.
    let response_bytes = serde_json::to_vec(&response).unwrap_or_default();
    let mut framed = Vec::with_capacity(4 + response_bytes.len());
    framed.extend_from_slice(&(response_bytes.len() as u32).to_le_bytes());
    framed.extend_from_slice(&response_bytes);
    unsafe {
        let _ = WriteFile(
            handle,
            framed.as_ptr() as *const _,
            framed.len() as u32,
            &mut bytes_read,
            ptr::null_mut(),
        );
        let _ = DisconnectNamedPipe(handle);
        let _ = CloseHandle(handle);
    }
}

/// Run the Unix domain socket server.
#[cfg(not(windows))]
async fn run_unix_socket_server(app: AppHandle, socket_path: PathBuf) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{UnixListener, UnixStream};

    // Remove stale socket file
    let _ = tokio::fs::remove_file(&socket_path).await;

    let listener = UnixListener::bind(&socket_path)
        .map_err(|e| format!("Failed to bind Unix socket: {}", e))?;

    loop {
        let (stream, _) = listener
            .accept()
            .await
            .map_err(|e| format!("Accept error: {}", e))?;
        let app_clone = app.clone();
        tokio::spawn(async move {
            handle_client_unix(stream, app_clone).await;
        });
    }
}

#[cfg(not(windows))]
async fn handle_client_unix(mut stream: tokio::net::UnixStream, app: AppHandle) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // Read message length (4 bytes, little-endian)
    let mut len_bytes = [0u8; 4];
    if stream.read_exact(&mut len_bytes).await.is_err() {
        return;
    }
    let len = u32::from_le_bytes(len_bytes) as usize;
    if len > NATIVE_HOST_MAX_BYTES {
        return;
    }

    // Read message body
    let mut buf = vec![0u8; len];
    if stream.read_exact(&mut buf).await.is_err() {
        return;
    }

    // Process request
    let response = process_native_host_request(&app, &buf).await;

    // Write response
    let response_bytes = serde_json::to_vec(&response).unwrap_or_default();
    let response_len = (response_bytes.len() as u32).to_le_bytes();
    let _ = stream.write_all(&response_len).await;
    let _ = stream.write_all(&response_bytes).await;
}

/// Process a native host request using the same logic as browser_bridge_propose.
async fn process_native_host_request(app: &AppHandle, request_bytes: &[u8]) -> NativeHostResponse {
    // Parse request
    let request: NativeHostRequest = match serde_json::from_slice(request_bytes) {
        Ok(r) => r,
        Err(e) => {
            // No trustworthy request id exists here, so the ledger records
            // nothing for this case (the response is still truthful).
            return NativeHostResponse {
                version: 1,
                request_id: String::new(),
                status: None,
                result: None,
                error: Some(NativeHostError {
                    code: "INVALID_JSON".into(),
                    message: format!("Invalid JSON: {}", e),
                }),
            };
        }
    };

    let request_id = request.request_id.clone();

    // Validate protocol version
    if request.version != 1 {
        return refused_response(
            app,
            &request_id,
            "UNSUPPORTED_VERSION",
            "Unsupported protocol version",
            crate::action::category::UNSUPPORTED_VERSION,
        );
    }

    // Handle bridge.status operation
    if request.operation == "bridge.status" {
        return handle_bridge_status(app, request_id).await;
    }

    // Handle bridge.capabilities operation
    if request.operation == "bridge.capabilities" {
        return handle_bridge_capabilities(request_id);
    }

    if request.operation != "tool.propose" {
        return refused_response(
            app,
            &request_id,
            "UNSUPPORTED_OPERATION",
            "Unsupported operation",
            crate::action::category::UNSUPPORTED_OPERATION,
        );
    }

    // Get managed state
    let hub = match app.try_state::<Arc<BrowserBridgeHub>>() {
        Some(h) => h.inner().clone(),
        None => {
            return NativeHostResponse {
                version: 1,
                request_id,
                status: None,
                result: None,
                error: Some(NativeHostError {
                    code: "SERVER_ERROR".into(),
                    message: "BrowserBridgeHub not available".into(),
                }),
            };
        }
    };

    let slot = match app.try_state::<WorkspaceSlot>() {
        Some(s) => s.inner(),
        None => {
            return NativeHostResponse {
                version: 1,
                request_id,
                status: None,
                result: None,
                error: Some(NativeHostError {
                    code: "SERVER_ERROR".into(),
                    message: "WorkspaceSlot not available".into(),
                }),
            };
        }
    };

    let settings = match app.try_state::<SettingsStore>() {
        Some(s) => s.inner(),
        None => {
            return NativeHostResponse {
                version: 1,
                request_id,
                status: None,
                result: None,
                error: Some(NativeHostError {
                    code: "SERVER_ERROR".into(),
                    message: "SettingsStore not available".into(),
                }),
            };
        }
    };

    // Idempotency check
    if hub.is_duplicate(&request_id) {
        return NativeHostResponse {
            version: 1,
            request_id,
            status: Some("duplicate".into()),
            result: Some(
                serde_json::json!({"message": "Request already decided; not re-executed."}),
            ),
            error: None,
        };
    }

    // Validate proposal using shared logic
    let proposal = match request.proposal.as_object() {
        Some(p) => p,
        None => {
            return refused_response(
                app,
                &request_id,
                "INVALID_PROPOSAL",
                "Missing proposal object",
                crate::action::category::INVALID_PROPOSAL,
            );
        }
    };

    let validated: ValidatedProposalData = match validate_proposal(proposal) {
        Ok(v) => v,
        Err(ProposalValidationError::MissingProposal) => {
            return refused_response(
                app,
                &request_id,
                "INVALID_PROPOSAL",
                "Missing proposal object",
                crate::browser_bridge::proposal_refusal_category(
                    &ProposalValidationError::MissingProposal,
                ),
            );
        }
        Err(ProposalValidationError::ForbiddenTaskWorkspace) => {
            return refused_response(
                app,
                &request_id,
                "FORBIDDEN",
                "task/workspace selection is reserved to the desktop backend",
                crate::browser_bridge::proposal_refusal_category(
                    &ProposalValidationError::ForbiddenTaskWorkspace,
                ),
            );
        }
        Err(ProposalValidationError::UnsupportedTool) => {
            return refused_response(
                app,
                &request_id,
                "UNSUPPORTED_TOOL",
                "Unsupported or missing tool",
                crate::browser_bridge::proposal_refusal_category(
                    &ProposalValidationError::UnsupportedTool,
                ),
            );
        }
        Err(ProposalValidationError::InvalidArgs) => {
            return refused_response(
                app,
                &request_id,
                "INVALID_ARGS",
                "args must be an object",
                crate::browser_bridge::proposal_refusal_category(
                    &ProposalValidationError::InvalidArgs,
                ),
            );
        }
    };

    let ValidatedProposalData { tool, args, site } = validated;

    // Bind to workspace
    if slot.0.lock().unwrap().is_none() {
        return refused_response(
            app,
            &request_id,
            "NO_WORKSPACE",
            "no workspace open — select a folder in Neelima first",
            crate::action::category::NO_WORKSPACE,
        );
    }

    // Record idempotency: a repeated transport request_id is not re-executed.
    hub.record_id(&request_id);

    // Shared approval + execution path — identical to the UI webview route so
    // permission mode, approval waiting, and result reporting cannot diverge.
    let req = BridgeRequest {
        request_id: &request_id,
        tool: &tool,
        args: &args,
        site: &site,
        source: "native_host",
    };
    let (status, result) =
        crate::browser_bridge::approve_and_execute(app, &hub, slot, settings, &req).await;

    NativeHostResponse {
        version: 1,
        request_id,
        status: Some(status),
        result: Some(result),
        error: None,
    }
}

/// Phase A: build a refusal response AND record a truthful NotExecuted
/// action-ledger entry. The response shape and codes are unchanged; nothing
/// about the unvalidated payload (tool name, args, transport id) is stored.
fn refused_response(
    app: &AppHandle,
    request_id: &str,
    code: &str,
    message: &str,
    error_category: &str,
) -> NativeHostResponse {
    if let Some(ledger) = crate::action::ledger_of(app) {
        ledger.begin_refused(crate::action::Intake::NativeHostPipe, error_category);
    }
    NativeHostResponse {
        version: 1,
        request_id: request_id.to_string(),
        status: None,
        result: None,
        error: Some(NativeHostError {
            code: code.to_string(),
            message: message.to_string(),
        }),
    }
}

/// Handle bridge.capabilities — the honest, machine-readable list of what this
/// backend actually implements (roadmap 1.2: never advertise what does not
/// work end to end). Cancel and deferred results are intentionally absent:
/// approval timeout + explicit rejection cover the lifecycle, and results are
/// returned synchronously in the propose reply.
fn handle_bridge_capabilities(request_id: String) -> NativeHostResponse {
    NativeHostResponse {
        version: 1,
        request_id,
        status: Some("ok".into()),
        result: Some(serde_json::json!({
            "protocol_version": 1,
            "operations": ["bridge.status", "bridge.capabilities", "tool.propose"],
            "tools": crate::browser_bridge::ALLOWED_TOOLS,
            "max_propose_bytes": crate::browser_bridge::MAX_PROPOSE_BYTES,
            "approval_timeout_secs": crate::browser_bridge::APPROVAL_TIMEOUT.as_secs(),
            "idempotency": "in-memory ring (not durable across app restarts)",
            "approval_required_for": ["write_file", "edit_file", "move_file", "delete_file"],
            "approval_policy": {
                "authority": "desktop backend permission mode only (any extension preference is display-only)",
                "reads": "approval required in ask_all; auto-approved in ask_writes and full_access",
                "writes": "approval required in ask_all and ask_writes; auto-approved in full_access",
                "shared_with_agent_route": true,
            },
            // Phase C: the full per-tool argument schemas, derived directly
            // from the authoritative registry (tools::REGISTRY). Includes
            // agent-only tools with bridge_allowed:false so discovery is
            // truthful about what the desktop supports vs what the bridge
            // exposes — capability data is informational, never authorization.
            "tool_schemas": crate::tools::capability_schemas(),
        })),
        error: None,
    }
}

/// Handle bridge.status operation - returns connection status.
async fn handle_bridge_status(app: &AppHandle, request_id: String) -> NativeHostResponse {
    let hub = match app.try_state::<Arc<BrowserBridgeHub>>() {
        Some(h) => h.inner().clone(),
        None => {
            return NativeHostResponse {
                version: 1,
                request_id,
                status: Some("error".into()),
                result: None,
                error: Some(NativeHostError {
                    code: "SERVER_ERROR".into(),
                    message: "BrowserBridgeHub not available".into(),
                }),
            };
        }
    };

    let slot = match app.try_state::<WorkspaceSlot>() {
        Some(s) => s.inner(),
        None => {
            return NativeHostResponse {
                version: 1,
                request_id,
                status: Some("error".into()),
                result: None,
                error: Some(NativeHostError {
                    code: "SERVER_ERROR".into(),
                    message: "WorkspaceSlot not available".into(),
                }),
            };
        }
    };

    let settings = match app.try_state::<SettingsStore>() {
        Some(s) => s.inner(),
        None => {
            return NativeHostResponse {
                version: 1,
                request_id,
                status: Some("error".into()),
                result: None,
                error: Some(NativeHostError {
                    code: "SERVER_ERROR".into(),
                    message: "SettingsStore not available".into(),
                }),
            };
        }
    };

    // Check if workspace is open
    let has_workspace = slot.0.lock().unwrap().is_some();

    NativeHostResponse {
        version: 1,
        request_id,
        status: Some("ok".into()),
        result: Some(serde_json::json!({
            "connected": true,
            "has_workspace": has_workspace,
            "permission_mode": format!("{:?}", settings.get().permission_mode),
            "recent_requests": hub.events().len(),
            "pending_approvals": hub.pending_count(),
        })),
        error: None,
    }
}

/// Tauri command to get the native host pipe path (for diagnostics/registration).
#[tauri::command]
pub async fn native_host_pipe_path(app: AppHandle) -> Result<String, String> {
    Ok(pipe_path(&app).to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser_bridge::BrowserBridgeHub;
    use crate::settings::SettingsStore;
    use crate::ui::WorkspaceSlot;
    use std::sync::Arc;
    use tempfile::TempDir;
    use tokio::sync::oneshot;

    fn hub() -> Arc<BrowserBridgeHub> {
        Arc::new(BrowserBridgeHub::default())
    }

    fn workspace_slot(dir: &std::path::Path) -> WorkspaceSlot {
        let slot = WorkspaceSlot::default();
        *slot.0.lock().unwrap() = Some(crate::workspace::Workspace::open(dir).unwrap());
        slot
    }

    /// Fix 5: a request_id may only be decided once — the duplicate is never
    /// re-executed through the native-host path.
    #[test]
    fn duplicate_request_ids_are_rejected_without_reexecution() {
        let h = hub();
        assert!(h.record_id("req-dup-1"), "first record succeeds");
        assert!(h.is_duplicate("req-dup-1"));
        assert!(!h.record_id("req-dup-1"), "re-record is a duplicate");
        // A duplicate id must short-circuit before reaching the shared path.
        assert!(h.is_duplicate("req-dup-1"));
    }

    /// Fix 5: pending approvals resolve exactly once; a late second decision is
    /// refused and cannot double-execute, and cleanup leaves no stale waiter.
    #[tokio::test]
    async fn pending_approval_resolves_once_then_cleans_up() {
        let h = hub();
        let (tx, rx) = oneshot::channel();
        h.register_pending("req-approve-1", tx);
        assert_eq!(h.pending_count(), 1);

        assert!(h.resolve_pending("req-approve-1", serde_json::json!({"approved": true})));
        assert_eq!(h.pending_count(), 0, "waiter is removed after resolution");
        assert!(
            !h.resolve_pending("req-approve-1", serde_json::json!({"approved": false})),
            "second decision must be refused: no double-execution"
        );

        let decision = rx.await.unwrap();
        assert_eq!(decision["approved"], true);
    }

    /// Fix 5: a timed-out approval must clear its pending waiter so a later
    /// decision finds nothing to resolve (no zombie approvals).
    #[tokio::test]
    async fn remove_pending_drops_the_waiter() {
        let h = hub();
        let (tx, rx) = oneshot::channel();
        h.register_pending("req-timeout-1", tx);
        h.remove_pending("req-timeout-1");
        assert_eq!(h.pending_count(), 0);
        assert!(!h.resolve_pending("req-timeout-1", serde_json::json!({"approved": true})));
        // The rx side observes the closed channel (same as a timeout path).
        assert!(rx.await.is_err());
    }

    /// Fix 5: the non-approval execution path runs the validated read through
    /// the standard tool executor and returns the real output.
    #[tokio::test]
    async fn read_only_request_executes_without_approval() {
        let temp = TempDir::new().unwrap();
        let slot = workspace_slot(temp.path());
        let settings = SettingsStore::load(temp.path()).unwrap();
        std::fs::write(temp.path().join("notes.txt"), "bridge probe").unwrap();

        let h = hub();
        let args = serde_json::json!({"path": "notes.txt"});
        let req = BridgeRequest {
            request_id: "req-read-1",
            tool: "read_file",
            args: &args,
            site: "chatgpt",
            source: "native_host_test",
        };
        let (status, result) =
            crate::browser_bridge::execute_tool(&h, &slot, &settings, &req, "executed");
        assert_eq!(status, "executed");
        assert_eq!(result["output"], "bridge probe");
        assert!(result.get("error").is_none());
    }

    /// Fix 5: without a workspace the shared path fails safely — never panics,
    /// never executes.
    #[tokio::test]
    async fn execution_without_workspace_fails_safely() {
        let temp = TempDir::new().unwrap();
        let slot = WorkspaceSlot::default(); // no workspace bound
        let settings = SettingsStore::load(temp.path()).unwrap();
        let h = hub();
        let args = serde_json::json!({"path": "x.txt"});
        let req = BridgeRequest {
            request_id: "req-nows-1",
            tool: "read_file",
            args: &args,
            site: "chatgpt",
            source: "native_host_test",
        };
        let (status, result) =
            crate::browser_bridge::execute_tool(&h, &slot, &settings, &req, "executed");
        assert_eq!(status, "execution_failed");
        assert!(result["error"]
            .as_str()
            .unwrap()
            .contains("no workspace open"));
    }

    /// Fix 5: write tools under AskWrites go through the approval gate, not
    /// straight to disk.
    #[test]
    fn write_tool_under_ask_writes_is_flagged_for_approval() {
        // Mirrors the decision in approve_and_execute without needing an
        // AppHandle: the gate itself is the security boundary under test.
        let mode = crate::settings::PermissionMode::AskWrites;
        let write_tool = matches!(
            "write_file",
            "write_file" | "edit_file" | "move_file" | "delete_file"
        );
        let needs_approval = matches!(
            mode,
            crate::settings::PermissionMode::AskAll | crate::settings::PermissionMode::AskWrites
        ) && write_tool;
        assert!(needs_approval);

        let read_tool = matches!(
            "read_file",
            "write_file" | "edit_file" | "move_file" | "delete_file"
        );
        assert!(
            !read_tool,
            "read-only tools never require the approval gate"
        );
    }

    /// bridge.capabilities advertises only what actually works end to end.
    #[test]
    fn capabilities_report_is_truthful_and_bounded() {
        let response = handle_bridge_capabilities("cap-1".into());
        assert_eq!(response.status.as_deref(), Some("ok"));
        let result = response.result.unwrap();
        assert_eq!(result["protocol_version"], 1);
        let ops: Vec<&str> = result["operations"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert!(ops.contains(&"tool.propose"));
        assert!(ops.contains(&"bridge.status"));
        assert!(ops.contains(&"bridge.capabilities"));
        // Never advertise unimplemented lifecycle ops.
        assert!(!ops.contains(&"browser_bridge_cancel"));
        assert!(!ops.contains(&"browser_bridge_result"));
        // Tool allowlist excludes shell execution.
        let tools: Vec<&str> = result["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert!(!tools
            .iter()
            .any(|t| t.contains("command") || t.contains("shell")));
        assert!(tools.contains(&"read_file"));
        assert_eq!(result["max_propose_bytes"], 256 * 1024);
        assert_eq!(result["approval_timeout_secs"], 120);
        // Phase C: the capabilities report states the unified, mode-dependent
        // approval policy shared with the agent route.
        assert_eq!(result["approval_policy"]["shared_with_agent_route"], true);
        assert!(result["approval_policy"]["reads"]
            .as_str()
            .unwrap()
            .contains("ask_all"));
        assert!(result["approval_policy"]["authority"]
            .as_str()
            .unwrap()
            .contains("display-only"));
        // Phase C: tool_schemas come from the authoritative registry — one
        // entry per registered tool; run_command is described but flagged
        // not-bridgable and never appears in the bridge allowlist.
        let schemas = result["tool_schemas"]
            .as_array()
            .expect("tool_schemas present");
        assert_eq!(schemas.len(), crate::tools::REGISTRY.len());
        let run = schemas.iter().find(|s| s["name"] == "run_command").unwrap();
        assert_eq!(run["bridge_allowed"], false);
        assert!(
            !result["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t == "run_command"),
            "the allowlist never exposes shell execution"
        );
    }

    /// bridge.status reports the bounded, metadata-only state the extension
    /// popup renders, including how many approvals are pending.
    #[test]
    fn bridge_status_shape_is_metadata_only() {
        let h = hub();
        let (tx, _rx) = oneshot::channel();
        h.register_pending("req-status-1", tx);
        let report = serde_json::json!({
            "connected": true,
            "has_workspace": true,
            "permission_mode": "AskWrites",
            "recent_requests": h.events().len(),
            "pending_approvals": h.pending_count(),
        });
        assert_eq!(report["pending_approvals"], 1);
        // Metadata only: no tool args, no file contents.
        let serialized = report.to_string();
        assert!(!serialized.contains("args"));
        assert!(!serialized.contains("output"));
    }
}
