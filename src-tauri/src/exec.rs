//! run_command execution: guarded, streamed, capped, cancellable.
//! The denylist/allowlist check happens in the agent before calling in here.
//! Cancellation (Stop button / global hotkey) kills the child AND, on Windows,
//! its process tree via `taskkill /T /F`.

use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::sync::Notify;

use crate::workspace::Workspace;

pub struct RunOutcome {
    pub ok: bool,
    pub output: String,
    pub timed_out: bool,
    pub killed: bool,
}

/// Run `command` with cwd confined to the workspace. `on_chunk` receives
/// streamed output as it arrives (agent emits it to the UI). Total retained
/// output is capped: we keep the TAIL (most recent) which is what matters for
/// debugging, with a truncation note.
pub async fn run_command_streaming(
    ws: &Workspace,
    cwd_rel: Option<&str>,
    command: &str,
    timeout_secs: u64,
    cap: usize,
    cancel: Arc<Notify>,
    mut on_chunk: impl FnMut(&str),
) -> RunOutcome {
    let cwd = match cwd_rel {
        Some(rel) => match ws.resolve(rel) {
            Ok(p) => p,
            Err(e) => return RunOutcome { ok: false, output: format!("run_command: {e}"), timed_out: false, killed: false },
        },
        None => ws.root().to_path_buf(),
    };

    #[cfg(windows)]
    let mut cmd = {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/C", command]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("sh");
        c.args(["-c", command]);
        c
    };

    cmd.current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return RunOutcome { ok: false, output: format!("run_command: failed to spawn: {e}"), timed_out: false, killed: false },
    };

    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let (chunk_tx, mut chunk_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    let tx_out = chunk_tx.clone();
    let tx_err = chunk_tx;
    tokio::spawn(async move {
        let mut buf = [0u8; 8192];
        loop {
            match stdout.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => { if tx_out.send(buf[..n].to_vec()).is_err() { break; } }
            }
        }
    });
    tokio::spawn(async move {
        let mut buf = [0u8; 8192];
        loop {
            match stderr.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => { if tx_err.send(buf[..n].to_vec()).is_err() { break; } }
            }
        }
    });

    let mut retained = String::new();
    let mut truncated = false;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs.max(1));
    let mut timed_out = false;
    let mut killed = false;

    loop {
        tokio::select! {
            _ = cancel.notified() => {
                kill_tree(&child.id().unwrap_or(0)).await;
                killed = true;
                let _ = child.wait().await;
                break;
            }
            _ = tokio::time::sleep_until(deadline) => {
                kill_tree(&child.id().unwrap_or(0)).await;
                timed_out = true;
                let _ = child.wait().await;
                break;
            }
            item = chunk_rx.recv() => {
                match item {
                    Some(bytes) => {
                        let s = String::from_utf8_lossy(&bytes);
                        on_chunk(&s);
                        retained.push_str(&s);
                        if retained.len() > cap * 2 {
                            let cut = retained.len() - cap;
                            let boundary = (cut..retained.len()).find(|i| retained.is_char_boundary(*i)).unwrap_or(cut);
                            retained.drain(..boundary);
                            truncated = true;
                        }
                    }
                    None => {
                        // both readers finished; wait for exit below
                        match child.wait().await {
                            Ok(st) => {
                                let code = st.code().unwrap_or(-1);
                                if retained.len() > cap {
                                    let cut = retained.len() - cap;
                                    let boundary = (cut..retained.len()).find(|i| retained.is_char_boundary(*i)).unwrap_or(cut);
                                    retained.drain(..boundary);
                                    truncated = true;
                                }
                                let mut out = String::new();
                                if truncated { out.push_str("[earlier output truncated; showing the tail]
"); }
                                out.push_str(retained.trim_end());
                                if out.is_empty() {
                                    out = if code == 0 { "(no output, exit 0)".into() } else { format!("(no output, exit {code})") };
                                }
                                return RunOutcome { ok: code == 0, output: format!("{out}
[exit code: {code}]"), timed_out: false, killed: false };
                            }
                            Err(e) => return RunOutcome { ok: false, output: format!("run_command: wait failed: {e}"), timed_out: false, killed: false },
                        }
                    }
                }
            }
        }
    }

    // Drain any remaining buffered output after kill/timeout.
    while let Ok(bytes) = chunk_rx.try_recv() {
        retained.push_str(&String::from_utf8_lossy(&bytes));
    }
    if retained.len() > cap {
        let cut = retained.len() - cap;
        let boundary = (cut..retained.len()).find(|i| retained.is_char_boundary(*i)).unwrap_or(cut);
        retained.drain(..boundary);
        truncated = true;
    }
    let mut out = String::new();
    if truncated { out.push_str("[earlier output truncated; showing the tail]
"); }
    out.push_str(retained.trim_end());
    if timed_out { out.push_str(&format!("
[timed out after {timeout_secs}s — process killed]")); }
    if killed { out.push_str("
[cancelled by user — process tree killed]"); }
    RunOutcome { ok: !killed && !timed_out, output: out, timed_out, killed }
}

async fn kill_tree(pid: &u32) {
    if *pid == 0 { return; }
    #[cfg(windows)]
    {
        let _ = tokio::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output()
            .await;
    }
    #[cfg(unix)]
    {
        let _ = tokio::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .output()
            .await;
    }
}

#[cfg(windows)]
trait CreationFlags {
    fn creation_flags(&mut self, flags: u32) -> &mut Self;
}
#[cfg(windows)]
impl CreationFlags for tokio::process::Command {
    fn creation_flags(&mut self, flags: u32) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.as_std_mut().creation_flags(flags);
        self
    }
}
