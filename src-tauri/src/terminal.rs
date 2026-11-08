//! Integrated terminal: xterm.js frontend (lazy-loaded), portable-pty backend.
//! Sessions are created only when the panel is opened; output is pushed to the
//! UI via events; no polling anywhere.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::Manager;

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

/// One PTY event, in stream order. `Exit` is always last for a session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TermEvent {
    Data { session: u32, data: String },
    Exit { session: u32, code: Option<u32> },
}

type EventSink = Arc<dyn Fn(TermEvent) + Send + Sync>;

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
    /// Terminate every live session and return how many were drained. The
    /// reader/wait thread for each session still emits its final `Exit` event,
    /// so callers get a truthful terminal status rather than a silent close.
    pub fn kill_all(&self) -> usize {
        let sessions: Vec<(u32, TermSession)> = self
            .sessions
            .lock()
            .unwrap()
            .drain()
            .collect();
        let count = sessions.len();
        for (_, mut session) in sessions {
            let _ = session.killer.kill();
        }
        count
    }
}

struct SpawnedTerm {
    id: u32,
    session: TermSession,
    reader: Box<dyn Read + Send>,
    child: Box<dyn Child + Send + Sync>,
}

/// Incremental UTF-8 decoder. A PTY read can split a multi-byte codepoint at
/// any byte boundary; decoding each 8 KiB chunk independently would corrupt it
/// into replacement characters. Incomplete trailing bytes are carried to the
/// next chunk (at most three), and malformed bytes become U+FFFD without
/// retaining unbounded state.
#[derive(Default)]
struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    fn push(&mut self, bytes: &[u8]) -> Option<String> {
        if bytes.is_empty() && self.pending.is_empty() {
            return None;
        }
        let mut data = std::mem::take(&mut self.pending);
        data.extend_from_slice(bytes);
        let mut out = String::new();
        let mut pos = 0usize;
        while pos < data.len() {
            match std::str::from_utf8(&data[pos..]) {
                Ok(valid) => {
                    out.push_str(valid);
                    pos = data.len();
                }
                Err(error) => {
                    let valid_len = error.valid_up_to();
                    if valid_len > 0 {
                        if let Ok(valid) = std::str::from_utf8(&data[pos..pos + valid_len]) {
                            out.push_str(valid);
                        }
                    }
                    pos += valid_len;
                    match error.error_len() {
                        Some(len) => {
                            out.push('\u{fffd}');
                            pos += len;
                        }
                        // Incomplete final sequence: keep it for the next read.
                        None => break,
                    }
                }
            }
        }
        self.pending = data[pos..].to_vec();
        (!out.is_empty()).then_some(out)
    }

    fn finish(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            return None;
        }
        let tail = std::mem::take(&mut self.pending);
        Some(String::from_utf8_lossy(&tail).into_owned())
    }
}

pub fn create(
    app: tauri::AppHandle,
    shell: Option<String>,
    cwd: Option<PathBuf>,
) -> Result<u32, String> {
    let SpawnedTerm {
        id,
        session,
        reader,
        child,
    } = open_process(shell, cwd)?;

    // Insert BEFORE starting the reader: a short-lived command can exit before
    // the thread is scheduled, and an exit arriving first must still clear the
    // registry entry instead of leaving a stale session behind.
    app.state::<TermState>()
        .sessions
        .lock()
        .unwrap()
        .insert(id, session);

    let app2 = app.clone();
    let sink: EventSink = Arc::new(move |event| {
        use tauri::Emitter;
        match event {
            TermEvent::Data { session, data } => {
                let _ = app2.emit(
                    "evt",
                    serde_json::json!({"kind": "term-data", "session": session, "data": data}),
                );
            }
            TermEvent::Exit { session, code } => {
                if let Some(state) = app2.try_state::<TermState>() {
                    state.sessions.lock().unwrap().remove(&session);
                }
                let _ = app2.emit(
                    "evt",
                    serde_json::json!({
                        "kind": "term-exit",
                        "session": session,
                        "code": code,
                    }),
                );
            }
        }
    });
    start_reader(id, reader, child, sink);
    Ok(id)
}

fn open_process(shell: Option<String>, cwd: Option<PathBuf>) -> Result<SpawnedTerm, String> {
    let shell_cmd = shell.unwrap_or_else(default_shell);
    let mut parts = shell_cmd.split_whitespace();
    let program = parts.next().unwrap_or("sh").to_string();
    let args: Vec<String> = parts.map(ToString::to_string).collect();
    open_command(program, args, cwd)
}

fn open_command(
    program: String,
    args: Vec<String>,
    cwd: Option<PathBuf>,
) -> Result<SpawnedTerm, String> {
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

    let mut cmd = CommandBuilder::new(program);
    for arg in args {
        cmd.arg(arg);
    }
    if let Some(c) = cwd {
        cmd.cwd(c);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("pty spawn: {e}"))?;
    let mut killer = child.clone_killer();
    drop(pair.slave);

    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(e) => {
            let _ = killer.kill();
            let _ = child.wait();
            return Err(format!("pty reader: {e}"));
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(e) => {
            let _ = killer.kill();
            let _ = child.wait();
            return Err(format!("pty writer: {e}"));
        }
    };
    let master = pair.master;

    Ok(SpawnedTerm {
        id,
        session: TermSession {
            writer: Box::new(writer),
            killer,
            master,
        },
        reader,
        child,
    })
}

fn start_reader(
    id: u32,
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn Child + Send + Sync>,
    sink: EventSink,
) {
    let reader_sink = sink.clone();
    std::thread::spawn(move || {
        let mut decoder = Utf8Stream::default();
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Some(text) = decoder.push(&buf[..n]) {
                        if !text.is_empty() {
                            reader_sink(TermEvent::Data {
                                session: id,
                                data: text,
                            });
                        }
                    }
                }
            }
        }
        if let Some(text) = decoder.finish() {
            if !text.is_empty() {
                reader_sink(TermEvent::Data {
                    session: id,
                    data: text,
                });
            }
        }
    });

    // A PTY reader does not necessarily reach EOF when the child exits: the
    // master side is still open in `TermSession`, and ConPTY in particular keeps
    // the pipe alive. Reap the child independently so `term-exit` and the real
    // exit code are always reported. The sink removes the session (dropping the
    // master), which lets the reader finish and release its buffer.
    std::thread::spawn(move || {
        let status = child.wait();
        // Let the reader deliver output already sitting in the PTY buffer before
        // announcing the exit. Ordering is best-effort; the UI never discards
        // data from a session, so late final bytes are still displayed.
        std::thread::sleep(std::time::Duration::from_millis(50));
        let code = status.ok().map(|status| status.exit_code());
        sink(TermEvent::Exit { session: id, code });
    });
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::{self, Receiver};
    use std::time::{Duration, Instant};

    fn test_command(script: &str) -> (String, Vec<String>) {
        #[cfg(windows)]
        {
            ("cmd.exe".to_string(), vec!["/c".to_string(), script.to_string()])
        }
        #[cfg(not(windows))]
        {
            ("/bin/sh".to_string(), vec!["-c".to_string(), script.to_string()])
        }
    }

    fn long_running_command() -> (String, Vec<String>) {
        #[cfg(windows)]
        {
            ("cmd.exe".to_string(), vec!["/c".to_string(), "pause".to_string()])
        }
        #[cfg(not(windows))]
        {
            ("/bin/sh".to_string(), vec!["-c".to_string(), "sleep 30".to_string()])
        }
    }

    fn collect_until_exit(rx: &Receiver<TermEvent>, timeout: Duration) -> (String, Option<u32>) {
        let deadline = Instant::now() + timeout;
        let mut data = String::new();
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(remaining) {
                Ok(TermEvent::Data { data: chunk, .. }) => data.push_str(&chunk),
                Ok(TermEvent::Exit { code, .. }) => return (data, code),
                Err(error) => panic!("terminal did not exit: {error}; output={data:?}"),
            }
        }
    }

    fn start_for_test(spawned: SpawnedTerm, state: Arc<TermState>) -> (u32, Receiver<TermEvent>) {
        let id = spawned.id;
        let (tx, rx) = mpsc::channel();
        state
            .sessions
            .lock()
            .unwrap()
            .insert(id, spawned.session);
        let sink: EventSink = Arc::new(move |event| {
            if let TermEvent::Exit { session, .. } = &event {
                // Mirror the production sink, which removes the session when
                // the reader observes the child exit.
                state.sessions.lock().unwrap().remove(session);
            }
            let _ = tx.send(event);
        });
        start_reader(id, spawned.reader, spawned.child, sink);
        (id, rx)
    }

    #[test]
    fn pty_streams_output_and_reports_successful_exit_code() {
        let (program, args) = test_command("echo HELLO_PTY");
        let spawned = open_command(program, args, None).expect("pty spawns");
        let state = Arc::new(TermState::default());
        let (_id, rx) = start_for_test(spawned, state.clone());
        let (data, code) = collect_until_exit(&rx, Duration::from_secs(10));
        assert!(data.contains("HELLO_PTY"), "output was {data:?}");
        assert_eq!(code, Some(0), "successful command exit code is reported");
        assert!(
            state.sessions.lock().unwrap().is_empty(),
            "the reader clears the session after a natural exit"
        );
    }

    #[test]
    fn pty_reports_a_nonzero_exit_code() {
        let (program, args) = test_command("exit 7");
        let spawned = open_command(program, args, None).expect("pty spawns");
        let (_id, rx) = start_for_test(spawned, Arc::new(TermState::default()));
        let (_data, code) = collect_until_exit(&rx, Duration::from_secs(10));
        assert_eq!(code, Some(7), "the real child exit status is preserved");
    }

    #[test]
    fn pty_accepts_input_through_the_session_writer() {
        #[cfg(windows)]
        let (program, args) = ("cmd.exe".to_string(), Vec::<String>::new());
        #[cfg(not(windows))]
        let (program, args) = ("/bin/sh".to_string(), Vec::<String>::new());
        let spawned = open_command(program, args, None).expect("interactive pty spawns");
        let state = Arc::new(TermState::default());
        let (id, rx) = start_for_test(spawned, state.clone());
        std::thread::sleep(Duration::from_millis(100));
        write(&state, id, "echo INPUT_TOKEN\r\n").expect("input reaches the shell");
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut output = String::new();
        loop {
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(TermEvent::Data { data, .. }) => {
                    output.push_str(&data);
                    if output.contains("INPUT_TOKEN") {
                        break;
                    }
                }
                Ok(TermEvent::Exit { .. }) => panic!("shell exited before input was echoed: {output:?}"),
                Err(error) => panic!("shell did not echo input: {error}; output={output:?}"),
            }
        }
        state.kill_all();
    }

    #[test]
    fn unknown_sessions_report_errors_instead_of_panicking() {
        let state = TermState::default();
        assert_eq!(write(&state, 999, "x").unwrap_err(), "terminal session not found");
        assert_eq!(resize(&state, 999, 24, 80).unwrap_err(), "terminal session not found");
        assert_eq!(kill(&state, 999).unwrap_err(), "terminal session not found");
    }

    #[test]
    fn spawning_a_missing_program_returns_an_error() {
        let error = open_command("neelima-definitely-missing-shell".into(), Vec::new(), None)
            .err()
            .expect("a missing shell cannot spawn");
        assert!(error.starts_with("pty spawn:"), "error was {error:?}");
    }

    #[test]
    fn kill_terminates_the_process_and_reports_exit() {
        let (program, args) = long_running_command();
        let spawned = open_command(program, args, None).expect("pty spawns");
        let state = Arc::new(TermState::default());
        let (id, rx) = start_for_test(spawned, state.clone());
        std::thread::sleep(Duration::from_millis(150));
        kill(&state, id).expect("the live session is killed");
        assert!(
            state.sessions.lock().unwrap().is_empty(),
            "kill removes the session immediately"
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(TermEvent::Exit { session, .. }) => {
                    assert_eq!(session, id);
                    break;
                }
                Ok(TermEvent::Data { .. }) => {}
                Err(error) => panic!("killed terminal never reported exit: {error}"),
            }
        }
    }

    #[test]
    fn kill_all_reaps_every_live_session() {
        let (program, args) = long_running_command();

        let first = open_command(program.clone(), args.clone(), None).expect("first pty");
        let second = open_command(program, args, None).expect("second pty");
        let state = Arc::new(TermState::default());
        let (id1, rx1) = start_for_test(first, state.clone());
        let (id2, rx2) = start_for_test(second, state.clone());
        assert_ne!(id1, id2, "each session has a distinct id");
        assert_eq!(state.kill_all(), 2, "both sessions are drained");
        assert!(state.sessions.lock().unwrap().is_empty());
        for rx in [rx1, rx2] {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                    Ok(TermEvent::Exit { .. }) => break,
                    Ok(TermEvent::Data { .. }) => {}
                    Err(error) => panic!("kill_all left a terminal unreaped: {error}"),
                }
            }
        }
    }

    /// Prints lifecycle timings under `cargo test ... -- --nocapture`. Timings
    /// are observations, not assertions about wall-clock performance.
    #[test]
    fn lifecycle_timing_is_reported() {
        let (program, args) = long_running_command();
        let state = Arc::new(TermState::default());
        let spawned = open_command(program, args, None).expect("pty spawns");
        let (id, rx) = start_for_test(spawned, state.clone());
        std::thread::sleep(Duration::from_millis(150));
        let killed_at = Instant::now();
        kill(&state, id).expect("live session killed");
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(TermEvent::Exit { .. }) => break,
                Ok(TermEvent::Data { .. }) => {}
                Err(error) => panic!("timing session never exited: {error}"),
            }
        }
        eprintln!(
            "terminal_lifecycle kill_to_exit_ms={} sessions_after_exit={}",
            killed_at.elapsed().as_millis(),
            state.sessions.lock().unwrap().len()
        );
    }

    #[test]
    fn utf8_stream_preserves_codepoints_split_across_reads() {
        let source = "plain é — 日本語 😀 tail";
        let bytes = source.as_bytes();
        let mut stream = Utf8Stream::default();
        let mut decoded = String::new();
        // One byte at a time is the worst case: every multi-byte codepoint is
        // split across several reads.
        for byte in bytes.chunks(1) {
            if let Some(part) = stream.push(byte) {
                decoded.push_str(&part);
            }
        }
        if let Some(tail) = stream.finish() {
            decoded.push_str(&tail);
        }
        assert_eq!(decoded, source);
        assert!(stream.pending.is_empty(), "no bytes are retained at EOF");
    }

    #[test]
    fn utf8_stream_replaces_invalid_bytes_and_does_not_hold_the_tail() {
        let mut stream = Utf8Stream::default();
        let first = stream.push(&[0xff, b'a']).expect("invalid byte decoded");
        assert_eq!(first, "\u{fffd}a");
        assert!(stream.pending.is_empty());
        assert!(stream.finish().is_none());

        // An incomplete trailing sequence is carried, then completed.
        let encoded = "😀".as_bytes();
        assert!(stream.push(&encoded[..2]).is_none());
        assert_eq!(stream.push(&encoded[2..]).as_deref(), Some("😀"));
    }
}
