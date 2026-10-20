//! Integrated terminal: xterm.js frontend (lazy-loaded), portable-pty backend.
//! Sessions are created only when the panel is opened; output is pushed to the
//! UI via events; no polling anywhere.

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::Manager;

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

pub struct TermSession {
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    master: Box<dyn MasterPty + Send>,
}

#[derive(Default)]
pub struct TermState {
    pub sessions: Mutex<HashMap<u32, TermSession>>,
}

impl TermState {
    pub fn kill_all(&self) {
        for (_, mut s) in self.sessions.lock().unwrap().drain() {
            let _ = s.killer.kill();
        }
    }
}

pub fn create(
    app: tauri::AppHandle,
    shell: Option<String>,
    cwd: Option<std::path::PathBuf>,
) -> Result<u32, String> {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("pty: {e}"))?;

    let shell_cmd = shell.unwrap_or_else(default_shell);
    let mut parts = shell_cmd.split_whitespace();
    let mut cmd = CommandBuilder::new(parts.next().unwrap_or("sh"));
    for arg in parts {
        cmd.arg(arg);
    }
    if let Some(c) = cwd {
        cmd.cwd(c);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("pty spawn: {e}"))?;
    let mut killer = child.clone_killer();
    drop(pair.slave);

    let mut reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(e) => {
            let _ = killer.kill();
            return Err(format!("pty reader: {e}"));
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(e) => {
            let _ = killer.kill();
            return Err(format!("pty writer: {e}"));
        }
    };
    let master = pair.master;

    app.state::<TermState>().sessions.lock().unwrap().insert(
        id,
        TermSession {
            writer: Box::new(writer),
            killer,
            master,
        },
    );

    // Reader thread: pushes output as events; exits when the pty closes.
    let app2 = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).into_owned();
                    use tauri::Emitter;
                    let _ = app2.emit(
                        "evt",
                        serde_json::json!({"kind": "term-data", "session": id, "data": text}),
                    );
                }
            }
        }
        use tauri::Emitter;
        if let Some(state) = app2.try_state::<TermState>() {
            state.sessions.lock().unwrap().remove(&id);
        }
        let _ = app2.emit(
            "evt",
            serde_json::json!({"kind": "term-exit", "session": id}),
        );
    });

    Ok(id)
}

pub fn write(state: &TermState, id: u32, data: &str) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let session = sessions.get_mut(&id).ok_or("terminal session not found")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

pub fn resize(state: &TermState, id: u32, rows: u16, cols: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions.get(&id).ok_or("terminal session not found")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

pub fn kill(state: &TermState, id: u32) -> Result<(), String> {
    if let Some(mut s) = state.sessions.lock().unwrap().remove(&id) {
        let _ = s.killer.kill();
        Ok(())
    } else {
        Err("terminal session not found".into())
    }
}

fn default_shell() -> String {
    #[cfg(windows)]
    {
        // Prefer modern PowerShell when installed, while keeping Windows
        // PowerShell as the out-of-box fallback on stock Windows machines.
        for candidate in ["pwsh.exe", "powershell.exe", "cmd.exe"] {
            if executable_in_path(candidate) {
                return if candidate == "pwsh.exe" || candidate == "powershell.exe" {
                    format!("{candidate} -NoLogo")
                } else {
                    candidate.into()
                };
            }
        }
        "powershell.exe -NoLogo".into()
    }
    #[cfg(not(windows))]
    {
        if let Ok(shell) = std::env::var("SHELL") {
            if std::path::Path::new(&shell).is_file() {
                return shell;
            }
        }
        ["/bin/bash", "/bin/zsh", "/bin/sh"]
            .into_iter()
            .find(|candidate| std::path::Path::new(candidate).is_file())
            .unwrap_or("/bin/sh")
            .into()
    }
}

#[cfg(windows)]
fn executable_in_path(name: &str) -> bool {
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
        .any(|directory| directory.join(name).is_file())
}
