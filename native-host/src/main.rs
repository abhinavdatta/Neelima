//! Native messaging host for Neelima Browser Bridge.
//!
//! This binary is registered with Chrome/Edge via Native Messaging manifests.
//! It reads length-prefixed JSON messages from stdin, forwards them to the
//! Neelima desktop app via a named pipe (Windows) or Unix domain socket,
//! reads the response, and writes it back to stdout.
//!
//! Protocol (matches browser_bridge.rs and native_host.rs):
//! - Request:  { version, request_id, operation: "tool.propose", proposal: {...} }
//! - Response: { version, request_id, status?, result?, error? }

use std::io::{self, Read, Write};

#[cfg(not(windows))]
use std::path::PathBuf;

#[cfg(not(windows))]
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

const PIPE_NAME: &str = "neelima-native-host";
const MAX_MESSAGE_BYTES: usize = 256 * 1024;

#[cfg(not(windows))]
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// The backend waits up to 120 s for an explicit user approval decision on
/// write/delete proposals; the pipe read must cover that whole window so the
/// REAL decision (not a transport timeout) reaches the extension.
#[cfg(not(windows))]
const REQUEST_TIMEOUT: Duration = Duration::from_secs(150);

/// Native Messaging uses a 4-byte little-endian length prefix.
fn read_message() -> Result<Option<Vec<u8>>, String> {
    let mut len_bytes = [0u8; 4];
    match io::stdin().read_exact(&mut len_bytes) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(format!("Failed to read message length: {}", e)),
    }
    let len = u32::from_le_bytes(len_bytes) as usize;
    if len > MAX_MESSAGE_BYTES {
        return Err(format!(
            "Message too large: {} bytes (max {})",
            len, MAX_MESSAGE_BYTES
        ));
    }
    let mut buf = vec![0u8; len];
    io::stdin()
        .read_exact(&mut buf)
        .map_err(|e| format!("Failed to read message body: {}", e))?;
    Ok(Some(buf))
}

fn write_message(buf: &[u8]) -> Result<(), String> {
    let len = (buf.len() as u32).to_le_bytes();
    io::stdout()
        .write_all(&len)
        .map_err(|e| format!("Failed to write message length: {}", e))?;
    io::stdout()
        .write_all(buf)
        .map_err(|e| format!("Failed to write message body: {}", e))?;
    io::stdout()
        .flush()
        .map_err(|e| format!("Failed to flush stdout: {}", e))
}

#[derive(Debug, Deserialize)]
struct HostRequest {
    version: u64,
    request_id: String,
    operation: String,
    // `proposal` is present only for tool.propose; bridge.status carries none.
    #[serde(default)]
    #[allow(dead_code)]
    proposal: Option<Value>,
}

#[derive(Debug, Serialize)]
struct HostResponse {
    version: u64,
    request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<HostError>,
}

#[derive(Debug, Serialize)]
struct HostError {
    code: String,
    message: String,
}

/// Get the pipe/socket path for the current platform (Unix only).
#[cfg(not(windows))]
fn pipe_path() -> PathBuf {
    let data_dir = dirs::data_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join(".local/share")))
        .expect("Could not determine data directory");
    data_dir.join("neelima").join(PIPE_NAME)
}

/// Send request to the Neelima app and get response.
async fn forward_request(request_bytes: &[u8]) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::System::Pipes::CallNamedPipeW;

        let pipe_name = format!(r"\\.\pipe\{}", PIPE_NAME);
        let wide: Vec<u16> = OsStr::new(&pipe_name)
            .encode_wide()
            .chain(Some(0))
            .collect();

        // The app-side server speaks the same length-prefixed framing as
        // Native Messaging: one message = 4-byte LE length + JSON. CallNamedPipeW
        // transacts ONE message in each direction, so the prefix must be part of
        // the request buffer, and the reply carries its own prefix.
        let mut framed_request = Vec::with_capacity(4 + request_bytes.len());
        framed_request.extend_from_slice(&(request_bytes.len() as u32).to_le_bytes());
        framed_request.extend_from_slice(request_bytes);

        // Must cover the backend's 120 s approval window plus margin, or a
        // user who approves at second 40 would get a transport timeout
        // instead of the real result.
        let mut response_buf = vec![0u8; MAX_MESSAGE_BYTES + 4];
        let mut bytes_read = 0u32;

        unsafe {
            let ok = CallNamedPipeW(
                wide.as_ptr(),
                framed_request.as_ptr() as *const _,
                framed_request.len() as u32,
                response_buf.as_mut_ptr() as *mut _,
                response_buf.len() as u32,
                &mut bytes_read,
                150_000, // 150 second timeout
            );
            if ok == 0 {
                let err = std::io::Error::last_os_error();
                return Err(format!("CallNamedPipeW failed: {}", err));
            }
        }
        response_buf.truncate(bytes_read as usize);
        if response_buf.len() < 4 {
            return Err("Empty response from Neelima app".to_string());
        }
        let body_len = u32::from_le_bytes(response_buf[..4].try_into().unwrap()) as usize;
        if body_len > MAX_MESSAGE_BYTES || 4 + body_len > response_buf.len() {
            return Err("Malformed response framing from Neelima app".to_string());
        }
        Ok(response_buf[4..4 + body_len].to_vec())
    }
    #[cfg(not(windows))]
    {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::UnixStream;
        use tokio::time::timeout;

        let path = pipe_path();
        let mut stream = timeout(CONNECT_TIMEOUT, UnixStream::connect(&path))
            .await
            .map_err(|_| "Connection timeout".to_string())?
            .map_err(|e| {
                format!(
                    "Failed to connect to Unix socket at {}: {}",
                    path.display(),
                    e
                )
            })?;

        // Write request with length prefix
        let len = (request_bytes.len() as u32).to_le_bytes();
        stream
            .write_all(&len)
            .await
            .map_err(|e| format!("Failed to write request length: {}", e))?;
        stream
            .write_all(request_bytes)
            .await
            .map_err(|e| format!("Failed to write request body: {}", e))?;
        stream
            .flush()
            .await
            .map_err(|e| format!("Failed to flush request: {}", e))?;

        // Read response length
        let mut len_bytes = [0u8; 4];
        timeout(REQUEST_TIMEOUT, stream.read_exact(&mut len_bytes))
            .await
            .map_err(|_| "Response timeout reading length".to_string())?
            .map_err(|e| format!("Failed to read response length: {}", e))?;
        let len = u32::from_le_bytes(len_bytes) as usize;
        if len > MAX_MESSAGE_BYTES {
            return Err(format!("Response too large: {} bytes", len));
        }

        // Read response body
        let mut buf = vec![0u8; len];
        timeout(REQUEST_TIMEOUT, stream.read_exact(&mut buf))
            .await
            .map_err(|_| "Response timeout reading body".to_string())?
            .map_err(|e| format!("Failed to read response body: {}", e))?;

        Ok(buf)
    }
}

#[tokio::main]
async fn main() {
    // Native messaging host main loop
    loop {
        match read_message() {
            Ok(Some(request_bytes)) => {
                // Parse and validate the request
                let request: HostRequest = match serde_json::from_slice(&request_bytes) {
                    Ok(r) => r,
                    Err(e) => {
                        let response = HostResponse {
                            version: 1,
                            request_id: String::new(),
                            status: None,
                            result: None,
                            error: Some(HostError {
                                code: "INVALID_JSON".into(),
                                message: format!("Invalid JSON: {}", e),
                            }),
                        };
                        let _ = write_message(&serde_json::to_vec(&response).unwrap());
                        continue;
                    }
                };

                let request_id = request.request_id.clone();

                // Validate protocol version
                if request.version != 1 {
                    let response = HostResponse {
                        version: 1,
                        request_id,
                        status: None,
                        result: None,
                        error: Some(HostError {
                            code: "UNSUPPORTED_VERSION".into(),
                            message: "Unsupported protocol version".into(),
                        }),
                    };
                    let _ = write_message(&serde_json::to_vec(&response).unwrap());
                    continue;
                }

                if request.operation != "tool.propose"
                    && request.operation != "bridge.status"
                    && request.operation != "bridge.capabilities"
                {
                    let response = HostResponse {
                        version: 1,
                        request_id,
                        status: None,
                        result: None,
                        error: Some(HostError {
                            code: "UNSUPPORTED_OPERATION".into(),
                            message: "Unsupported operation".into(),
                        }),
                    };
                    let _ = write_message(&serde_json::to_vec(&response).unwrap());
                    continue;
                }

                // Forward to Neelima app
                match forward_request(&request_bytes).await {
                    Ok(response_bytes) => {
                        // Forward the response back to the extension
                        let _ = write_message(&response_bytes);
                    }
                    Err(e) => {
                        let response = HostResponse {
                            version: 1,
                            request_id,
                            status: None,
                            result: None,
                            error: Some(HostError {
                                code: "IPC_ERROR".into(),
                                message: format!("Failed to communicate with Neelima app: {}", e),
                            }),
                        };
                        let _ = write_message(&serde_json::to_vec(&response).unwrap());
                    }
                }
            }
            Ok(None) => {
                // EOF - extension disconnected
                break;
            }
            Err(e) => {
                eprintln!("Native host read error: {}", e);
                break;
            }
        }
    }
}
