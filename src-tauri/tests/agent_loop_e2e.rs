//! Integration test: the REAL agent loop (`neelima_lib::agent::run`) driven
//! through the production manual-relay provider against a REAL temporary
//! filesystem. This exercises the app's actual Provider plumbing, the real
//! protocol parser (fenced ```tool blocks), the approval channel, the real
//! tool dispatcher, workspace confinement, the command guard, the iteration /
//! circuit-breaker safeguards, and the history store. There is NO parallel
//! mock agent: the test plays the remote AI's role by pasting protocol
//! replies into the RelaySlot — exactly how a human uses the manual-relay
//! provider in production.
//!
//! Scenarios:
//!   1. happy path (AskWrites): write → REAL approval → disk check → result
//!      back → read → result back → DONE → Done with exactly 2 executions.
//!   2. invalid tool args → ok:false result returned to the model, loop keeps
//!      going, nothing written.
//!   3. workspace path traversal (`../escape.txt`) rejected, nothing escapes.
//!   4. malformed tool block → parse-error correction prompt, zero executions.
//!   5. iteration limit → terminal Error, no infinite loop.
//!   6. circuit breaker: same failing tool 3× → terminal Error.
//!   7. Stop mid-task → Cancelled ("stopped by user").
//!   8. approved command → genuine stdout returned to the provider.
//!
//! The per-task tool nonce is disabled for the manual relay by design
//! (agent.rs: a human copies/pastes); its enforcement is unit-tested in
//! protocol.rs (`task_nonce_is_required_and_removed_before_execution`).

use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use neelima_lib::agent::{
    run, ActiveAgent, AgentCommand, AgentInput, AgentShared, AgentState, CallDecision, EVT,
};
use neelima_lib::history::HistoryStore;
use neelima_lib::providers::{ManualProvider, Provider, RelaySlot};
use neelima_lib::settings::{PermissionMode, Settings};
use neelima_lib::webprov::WebviewState;
use neelima_lib::workspace::Workspace;
use serde_json::Value;
use tauri::{Listener, Manager};

const DEADLINE: Duration = Duration::from_secs(60);

#[derive(Default)]
struct Captured {
    prompts: Vec<String>,
    tool_call_batches: usize,
    /// (state, text) pairs from `agent-state` events.
    states: Vec<(String, String)>,
}

impl Captured {
    fn clone_inner(&self) -> Captured {
        Captured {
            prompts: self.prompts.clone(),
            tool_call_batches: self.tool_call_batches,
            states: self.states.clone(),
        }
    }
}

struct Harness {
    relay: Arc<RelaySlot>,
    shared: Arc<AgentShared>,
    captured: Arc<Mutex<Captured>>,
    app: tauri::AppHandle,
    app_thread: Option<JoinHandle<()>>,
    app_exited: std::sync::mpsc::Receiver<()>,
    ws_root: std::path::PathBuf,
    history_root: std::path::PathBuf,
    _runtime_guard: MutexGuard<'static, ()>,
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.app.exit(0);
        if self.app_exited.recv_timeout(Duration::from_secs(5)).is_ok() {
            if let Some(thread) = self.app_thread.take() {
                thread.join().expect("headless Tauri event loop exits");
            }
        }
        let _ = std::fs::remove_dir_all(&self.ws_root);
        let _ = std::fs::remove_dir_all(&self.history_root);
    }
}

impl Harness {
    fn wait_state(&self, want: AgentState, deadline: Instant) {
        loop {
            if self.shared.current_state() == want {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "timeout waiting for state {want:?}; now {:?}",
                self.shared.current_state()
            );
            std::thread::sleep(Duration::from_millis(15));
        }
    }

    /// Wait until at least `n` prompts have been sent to the relay.
    fn wait_prompts(&self, n: usize, deadline: Instant) {
        loop {
            if self.captured.lock().unwrap().prompts.len() >= n {
                return;
            }
            let snapshot = self.snapshot();
            assert!(
                Instant::now() < deadline,
                "timeout waiting for prompt {n}; have {} prompts, states={:?}",
                snapshot.prompts.len(),
                snapshot.states
            );
            std::thread::sleep(Duration::from_millis(15));
        }
    }

    fn paste(&self, text: &str) {
        assert!(
            self.relay.deliver(text.to_string()),
            "relay must accept a reply while the task is live"
        );
    }

    fn wait_terminal(&self, deadline: Instant) -> AgentState {
        loop {
            let s = self.shared.current_state();
            if matches!(
                s,
                AgentState::Done | AgentState::Error | AgentState::Cancelled
            ) {
                return s;
            }
            assert!(
                Instant::now() < deadline,
                "timeout waiting for terminal state; state={s:?}"
            );
            std::thread::sleep(Duration::from_millis(15));
        }
    }

    fn snapshot(&self) -> Captured {
        self.captured.lock().unwrap().clone_inner()
    }
}

/// Run the production Wry event loop on its own thread so the agent's emitted
/// events are delivered while the test drives the manual provider relay.
/// The lock prevents multiple tao event loops from being created concurrently.
fn harness(tag: &str, mode: PermissionMode, max_iterations: u32, prompt: &str) -> Harness {
    harness_seeded(tag, mode, max_iterations, prompt, &[])
}

/// Same harness, with files written into the temp workspace BEFORE the agent
/// starts, so Step 3 context selection has something to find.
fn harness_seeded(
    tag: &str,
    mode: PermissionMode,
    max_iterations: u32,
    prompt: &str,
    files: &[(&str, &str)],
) -> Harness {
    static RUNTIME_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let runtime_guard = RUNTIME_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
    let (exited_tx, exited_rx) = std::sync::mpsc::channel();
    let tag = tag.to_string();
    let prompt = prompt.to_string();
    let files: Vec<(String, String)> = files
        .iter()
        .map(|(rel, body)| ((*rel).to_string(), (*body).to_string()))
        .collect();

    let app_thread = std::thread::spawn(move || {
        let app = tauri::Builder::default()
            .any_thread()
            .build(tauri::generate_context!())
            .expect("headless Wry app builds");
        let handle = app.handle().clone();
        handle.manage(ActiveAgent::default());
        // Step 2: production `run()` manages the canonical request registry in
        // its setup hook. This harness builds a bare Tauri app (no app setup),
        // so the agent's request tracking needs the same state registered here —
        // otherwise `state()` panics inside the task and the task dies.
        handle.manage(Arc::new(neelima_lib::request::RequestRegistry::default()));
        // Phase A: the unified action ledger — managed here for the same
        // reason as the registry (production `run()` manages it in setup).
        handle.manage(Arc::new(neelima_lib::action::ActionLedger::default()));

        let ws_dir = std::env::temp_dir().join(format!(
            "neelima-e2e-{tag}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&ws_dir).expect("temp workspace created");
        for (rel, body) in files {
            let path = ws_dir.join(rel);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("seed dir created");
            }
            std::fs::write(&path, body).expect("seed file written");
        }
        let ws = Workspace::open(&ws_dir).expect("workspace opens");
        let ws_root = ws.root().to_path_buf();

        let hist_dir = std::env::temp_dir().join(format!(
            "neelima-e2e-hist-{tag}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&hist_dir).expect("history dir created");

        let relay = Arc::new(RelaySlot::default());
        let task_id = uuid::Uuid::new_v4().simple().to_string();
        let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel();
        let shared = Arc::new(AgentShared {
            cmd_tx,
            cmd_rx: Mutex::new(Some(cmd_rx)),
            state: Mutex::new(AgentState::Idle),
            task_id: Mutex::new(Some(task_id.clone())),
        });

        let captured: Arc<Mutex<Captured>> = Arc::new(Mutex::new(Captured::default()));
        {
            let sink = captured.clone();
            handle.listen(EVT, move |event| {
                let Ok(v) = serde_json::from_str::<Value>(event.payload()) else {
                    return;
                };
                let mut c = sink.lock().unwrap();
                match v["kind"].as_str() {
                    Some("relay-outbound") => {
                        if let Some(text) = v["text"].as_str() {
                            c.prompts.push(text.to_string());
                        }
                    }
                    Some("transcript") => {
                        if v["entry"]["kind"] == "tool_calls" {
                            c.tool_call_batches += 1;
                        }
                    }
                    Some("agent-state") => {
                        c.states.push((
                            v["state"].as_str().unwrap_or("").to_string(),
                            v["text"].as_str().unwrap_or("").to_string(),
                        ));
                    }
                    _ => {}
                }
            });
        }

        let provider = Provider::Manual(ManualProvider::new(handle.clone(), relay.clone()));
        let input = AgentInput {
            app: handle.clone(),
            task_id: task_id.clone(),
            conversation_id: task_id,
            prompt,
            skill_context: String::new(),
            // Context stays enabled: with no lexical match the block is empty, so
            // these tests also prove the prompt is unchanged from Step 2.
            context: neelima_lib::context::Options::default(),
            provider,
            ws,
            settings: Settings {
                permission_mode: mode,
                max_iterations,
                ..Settings::default()
            },
            history: Arc::new(HistoryStore::new(hist_dir.clone())),
            webview_state: Arc::new(WebviewState::default()),
            shared: shared.clone(),
            prior_entries: Vec::new(),
        };
        tauri::async_runtime::spawn(run(input));

        ready_tx
            .send((handle, relay, shared, captured, ws_root, hist_dir))
            .expect("test receives the running app handles");
        app.run_return(|_, _| {});
        let _ = exited_tx.send(());
    });

    let (app, relay, shared, captured, ws_root, history_root) = ready_rx
        .recv_timeout(DEADLINE)
        .expect("headless Wry app starts its event loop");
    Harness {
        relay,
        shared,
        captured,
        app,
        app_thread: Some(app_thread),
        app_exited: exited_rx,
        ws_root,
        history_root,
        _runtime_guard: runtime_guard,
    }
}

fn tool_block(id: &str, tool: &str, args_json: &str) -> String {
    format!("```tool\n{{\"id\":\"{id}\",\"tool\":\"{tool}\",\"args\":{args_json}}}\n```")
}

/// Extract the ```result payload for `call_id` from a prompt and check its id.
fn result_payload(prompt: &str, call_id: &str) -> Value {
    let start = prompt
        .find("```result")
        .unwrap_or_else(|| panic!("prompt lacks a result block: {prompt}"));
    let json_start = start + prompt[start..].find('{').expect("result JSON opens");
    let end = json_start + prompt[json_start..].rfind('}').expect("result JSON closes");
    let v: Value = serde_json::from_str(&prompt[json_start..=end]).expect("result JSON parses");
    assert_eq!(v["id"].as_str().unwrap_or_default(), call_id);
    v
}

// ---------------------------------------------------------------------------
// 1. Main scenario: two tool rounds over a real temp filesystem (AskWrites,
//    with a genuine approval round in the middle).
// ---------------------------------------------------------------------------

#[test]
fn agent_loop_two_rounds_over_real_fs_with_approval() {
    let h = harness(
        "happy",
        PermissionMode::AskWrites,
        12,
        "Create hello.txt containing exactly 'hello', then read it back.",
    );
    let deadline = Instant::now() + DEADLINE;

    // Round 1: the "model" asks to create the file.
    h.wait_prompts(1, deadline);
    let prompts = h.snapshot().prompts;
    assert!(
        prompts[0].contains("```tool"),
        "preamble states the tool protocol"
    );
    assert!(
        prompts[0].contains("Workspace root:"),
        "preamble states the workspace root"
    );
    let write = tool_block(
        "w1",
        "write_file",
        "{\"path\":\"hello.txt\",\"content\":\"hello\"}",
    );
    h.paste(&write);

    // Permission gate: AskWrites must stop for an explicit approval.
    h.wait_state(AgentState::AwaitingApproval, deadline);
    h.shared
        .cmd_tx
        .send(AgentCommand::Approve(vec![CallDecision {
            id: "w1".into(),
            approved: true,
        }]))
        .expect("approval channel is open");

    // Round 2: the write result arrives; the "model" reads the file back.
    h.wait_prompts(2, deadline);
    let prompts = h.snapshot().prompts;
    let w1 = result_payload(&prompts[1], "w1");
    assert_eq!(w1["ok"], Value::Bool(true), "write result ok: {w1}");
    let file = h.ws_root.join("hello.txt");
    assert_eq!(
        std::fs::read_to_string(&file).expect("file exists on disk"),
        "hello",
        "approved write landed on disk"
    );
    h.paste(&tool_block("r1", "read_file", "{\"path\":\"hello.txt\"}"));

    // Round 3: the read result arrives; the "model" finishes.
    h.wait_prompts(3, deadline);
    let prompts = h.snapshot().prompts;
    let r1 = result_payload(&prompts[2], "r1");
    assert_eq!(r1["ok"], Value::Bool(true), "read result ok: {r1}");
    assert!(
        r1["output"].as_str().unwrap_or("").contains("hello"),
        "read result carries the file content: {r1}"
    );
    h.paste("DONE: created hello.txt containing 'hello' and verified it by reading it back.");

    let state = h.wait_terminal(deadline);
    let snap = h.snapshot();
    assert_eq!(state, AgentState::Done, "states: {:?}", snap.states);
    assert_eq!(prompts.len(), 3);
    // Exactly two rounds executed — no duplicate tool execution.
    assert_eq!(snap.tool_call_batches, 2);
    assert!(
        snap.states.iter().any(|(s, _)| s == "done"),
        "a 'done' state event was emitted"
    );
}

#[test]
fn approved_command_output_is_returned_to_provider() {
    let h = harness(
        "command",
        PermissionMode::AskWrites,
        12,
        "Run a harmless output command and report what it prints.",
    );
    let deadline = Instant::now() + DEADLINE;

    h.wait_prompts(1, deadline);
    h.paste(&tool_block(
        "c1",
        "run_command",
        "{\"command\":\"echo approved-command-output\"}",
    ));

    h.wait_state(AgentState::AwaitingApproval, deadline);
    h.shared
        .cmd_tx
        .send(AgentCommand::Approve(vec![CallDecision {
            id: "c1".into(),
            approved: true,
        }]))
        .expect("approval channel is open");

    h.wait_prompts(2, deadline);
    let prompts = h.snapshot().prompts;
    let command = result_payload(&prompts[1], "c1");
    assert_eq!(
        command["ok"],
        Value::Bool(true),
        "command result: {command}"
    );
    assert!(
        command["output"]
            .as_str()
            .unwrap_or("")
            .contains("approved-command-output"),
        "genuine command stdout is returned to the provider: {command}"
    );

    h.paste("DONE: command output received.");
    assert_eq!(h.wait_terminal(deadline), AgentState::Done);
    assert_eq!(h.snapshot().tool_call_batches, 1);
}

// ---------------------------------------------------------------------------
// 2. Invalid tool arguments: error result returned to the model, loop
//    continues to a normal DONE, nothing written.
// ---------------------------------------------------------------------------

#[test]
fn invalid_tool_args_return_error_result_and_loop_continues() {
    let h = harness("badargs", PermissionMode::FullAccess, 12, "Write a file.");
    let deadline = Instant::now() + DEADLINE;

    h.wait_prompts(1, deadline);
    // write_file without the required "path" argument.
    h.paste(&tool_block("b1", "write_file", "{\"content\":\"x\"}"));

    h.wait_prompts(2, deadline);
    let prompts = h.snapshot().prompts;
    let b1 = result_payload(&prompts[1], "b1");
    assert_eq!(b1["ok"], Value::Bool(false), "invalid args must fail: {b1}");
    assert!(!h.ws_root.join("x").exists(), "nothing may be written");

    h.paste("DONE: stopped after the invalid call.");
    let state = h.wait_terminal(deadline);
    assert_eq!(state, AgentState::Done);
    assert_eq!(h.snapshot().tool_call_batches, 1);
}

// ---------------------------------------------------------------------------
// 3. Workspace confinement: a relative path that escapes the root is rejected.
// ---------------------------------------------------------------------------

#[test]
fn path_traversal_outside_workspace_is_rejected() {
    let h = harness(
        "traversal",
        PermissionMode::FullAccess,
        12,
        "Escape attempt.",
    );
    let deadline = Instant::now() + DEADLINE;

    let outside = h.ws_root.parent().unwrap().join("escape.txt");
    let _ = std::fs::remove_file(&outside);

    h.wait_prompts(1, deadline);
    h.paste(&tool_block(
        "e1",
        "write_file",
        "{\"path\":\"../escape.txt\",\"content\":\"nope\"}",
    ));

    h.wait_prompts(2, deadline);
    let prompts = h.snapshot().prompts;
    let e1 = result_payload(&prompts[1], "e1");
    assert_eq!(e1["ok"], Value::Bool(false), "traversal must fail: {e1}");
    assert!(!outside.exists(), "nothing may be written outside the root");

    h.paste("DONE: escape blocked.");
    let state = h.wait_terminal(deadline);
    assert_eq!(state, AgentState::Done);
    assert_eq!(h.snapshot().tool_call_batches, 1);
}

// ---------------------------------------------------------------------------
// 4. Malformed tool block: parse-error correction prompt, zero executions.
// ---------------------------------------------------------------------------

#[test]
fn malformed_tool_block_asks_for_correction_without_executing() {
    let h = harness("malformed", PermissionMode::FullAccess, 12, "Do a thing.");
    let deadline = Instant::now() + DEADLINE;

    h.wait_prompts(1, deadline);
    h.paste("```tool\n{this is not json}\n```");

    // The parser error is fed back as a new prompt (no result block).
    h.wait_prompts(2, deadline);
    let prompts = h.snapshot().prompts;
    assert!(
        prompts[1].contains("malformed and could not be parsed"),
        "parse error must be explained: {}",
        prompts[1]
    );
    assert!(!prompts[1].contains("```result"), "no tool ran");
    assert_eq!(h.snapshot().tool_call_batches, 0);

    h.paste("DONE: understood.");
    let state = h.wait_terminal(deadline);
    assert_eq!(state, AgentState::Done);
}

// ---------------------------------------------------------------------------
// 5. Iteration limit: a model that never finishes is stopped by the cap.
// ---------------------------------------------------------------------------

#[test]
fn iteration_limit_stops_an_endless_loop() {
    let h = harness(
        "iterations",
        PermissionMode::FullAccess,
        3,
        "Loop forever with reads.",
    );
    std::fs::write(h.ws_root.join("anything.txt"), "present").expect("fixture file is created");
    let deadline = Instant::now() + DEADLINE;

    // Always answer with another tool call; never DONE.
    let mut last_n = 0;
    loop {
        h.wait_prompts(last_n + 1, deadline);
        last_n = h.snapshot().prompts.len();
        if h.shared.current_state() == AgentState::Error {
            break;
        }
        h.paste(&tool_block(
            &format!("i{last_n}"),
            "read_file",
            "{\"path\":\"anything.txt\"}",
        ));
        assert!(
            Instant::now() < deadline,
            "iteration cap never tripped; {} prompts",
            h.snapshot().prompts.len()
        );
    }

    let snap = h.snapshot();
    assert!(snap.tool_call_batches >= 3, "cap reached after >=3 rounds");
    assert_eq!(
        snap.tool_call_batches, 3,
        "exactly max_iterations rounds run"
    );
    assert!(
        snap.states
            .iter()
            .any(|(s, text)| s == "error" && text.contains("iteration limit")),
        "the iteration cap is surfaced as an error state: {:?}",
        snap.states
    );
}

// ---------------------------------------------------------------------------
// 6. Circuit breaker: the same failing tool three times in a row terminates
//    the loop with an error instead of looping forever.
// ---------------------------------------------------------------------------

#[test]
fn circuit_breaker_after_three_consecutive_tool_failures() {
    let h = harness("breaker", PermissionMode::FullAccess, 25, "Read a file.");
    let deadline = Instant::now() + DEADLINE;

    let missing = tool_block("f1", "read_file", "{\"path\":\"no-such-file.txt\"}");
    for round in 1..=3 {
        h.wait_prompts(round, deadline);
        h.paste(&missing);
    }
    let state = h.wait_terminal(deadline);
    let snap = h.snapshot();
    assert_eq!(state, AgentState::Error, "states: {:?}", snap.states);
    assert_eq!(snap.tool_call_batches, 3, "exactly three failing rounds");
    assert!(
        snap.states
            .iter()
            .any(|(s, text)| s == "error" && text.contains("circuit breaker")),
        "the failure is reported as an error state: {:?}",
        snap.states
    );
    assert!(
        snap.states.iter().any(|(s, _)| s == "error"),
        "an 'error' state event was emitted"
    );
}

// ---------------------------------------------------------------------------
// 7. Stop mid-task: the command channel cancels a live run.
// ---------------------------------------------------------------------------

#[test]
fn stop_command_cancels_a_running_task() {
    let h = harness("stop", PermissionMode::FullAccess, 20, "Do something long.");
    let deadline = Instant::now() + DEADLINE;

    h.wait_prompts(1, deadline);
    // Park a tool call in the relay; while the agent is mid-flight, stop it.
    h.shared
        .cmd_tx
        .send(AgentCommand::Stop)
        .expect("command channel is open");

    let state = h.wait_terminal(deadline);
    let snap = h.snapshot();
    assert_eq!(state, AgentState::Cancelled, "states: {:?}", snap.states);
    assert!(
        snap.states
            .iter()
            .any(|(s, t)| s == "cancelled" && t.contains("stopped by user")),
        "the user is told the task was stopped: {:?}",
        snap.states
    );
}

// ---------------------------------------------------------------------------
// 8. Step 3: selected workspace context reaches the provider prompt.
// ---------------------------------------------------------------------------

#[test]
fn project_context_reaches_the_first_provider_prompt() {
    let h = harness_seeded(
        "context",
        PermissionMode::AskAll,
        4,
        "where is the token bucket rate limiter implemented",
        &[
            (
                "src/ratelimit.rs",
                "pub struct TokenBucket { tokens: u32 }\n// token bucket rate limiter\n",
            ),
            ("src/unrelated.css", "body { color: rebeccapurple; }\n"),
        ],
    );
    let deadline = Instant::now() + DEADLINE;
    h.wait_prompts(1, deadline);
    let prompt = h.snapshot().prompts[0].clone();
    assert!(
        prompt.contains("[PROJECT CONTEXT"),
        "selector block missing from the outbound prompt: {prompt}"
    );
    assert!(
        prompt.contains("src/ratelimit.rs"),
        "the selected file path is not in the prompt: {prompt}"
    );
    assert!(
        prompt.contains("TokenBucket"),
        "the selected file contents are not in the prompt: {prompt}"
    );
    assert!(
        !prompt.contains("rebeccapurple"),
        "an unrelated file was attached: {prompt}"
    );
    assert!(
        prompt.find("[END PROJECT CONTEXT]").unwrap() < prompt.find("TASK:").unwrap(),
        "context must precede the instruction: {prompt}"
    );
}

// ---------------------------------------------------------------------------
// 9. Phase 4: a denied approval and a denylisted command must not run.
// ---------------------------------------------------------------------------

#[test]
fn a_denied_approval_executes_nothing() {
    let h = harness(
        "denied",
        PermissionMode::AskWrites,
        8,
        "Create secret.txt only if I approve it.",
    );
    let deadline = Instant::now() + DEADLINE;

    h.wait_prompts(1, deadline);
    h.paste(&tool_block(
        "d1",
        "write_file",
        "{\"path\":\"secret.txt\",\"content\":\"should not exist\"}",
    ));
    h.wait_state(AgentState::AwaitingApproval, deadline);
    h.shared
        .cmd_tx
        .send(AgentCommand::Approve(vec![CallDecision {
            id: "d1".into(),
            approved: false,
        }]))
        .expect("approval channel is open");

    h.wait_prompts(2, deadline);
    let prompts = h.snapshot().prompts;
    let d1 = result_payload(&prompts[1], "d1");
    assert_eq!(
        d1["ok"],
        Value::Bool(false),
        "denied call reports failure: {d1}"
    );
    assert!(
        d1["output"]
            .as_str()
            .unwrap_or("")
            .contains("rejected by the user"),
        "the model is told it was denied: {d1}"
    );
    assert!(
        !h.ws_root.join("secret.txt").exists(),
        "a denied write must never reach disk"
    );

    h.paste("DONE: nothing was written.");
    let state = h.wait_terminal(deadline);
    assert_eq!(state, AgentState::Done, "states: {:?}", h.snapshot().states);
}

#[test]
fn a_denylisted_command_is_refused_before_any_shell_starts() {
    let h = harness(
        "denied-cmd",
        PermissionMode::FullAccess,
        8,
        "Try the most destructive command you can think of.",
    );
    let deadline = Instant::now() + DEADLINE;

    h.wait_prompts(1, deadline);
    // In FullAccess this still opens the approval dialog (always-ask), and even
    // an explicit approval cannot start it: the denylist is checked afterwards.
    h.paste(&tool_block(
        "c1",
        "run_command",
        "{\"command\":\"rm -rf /\"}",
    ));
    h.wait_state(AgentState::AwaitingApproval, deadline);
    h.shared
        .cmd_tx
        .send(AgentCommand::Approve(vec![CallDecision {
            id: "c1".into(),
            approved: true,
        }]))
        .expect("approval channel is open");

    h.wait_prompts(2, deadline);
    let prompts = h.snapshot().prompts;
    let c1 = result_payload(&prompts[1], "c1");
    assert_eq!(
        c1["ok"],
        Value::Bool(false),
        "denylisted command must fail: {c1}"
    );
    assert!(
        c1["output"]
            .as_str()
            .unwrap_or("")
            .contains("blocked by deny pattern"),
        "the deny reason is reported to the model: {c1}"
    );
    // Nothing in the workspace may have been touched by the attempt.
    assert!(h.ws_root.exists(), "the workspace still exists");

    h.paste("DONE: the command was blocked by the guard.");
    let state = h.wait_terminal(deadline);
    assert_eq!(state, AgentState::Done, "states: {:?}", h.snapshot().states);
}

// ---------------------------------------------------------------------------
// 10. Phase 4: decisions are matched per ROUND, not per raw model id. Models
//     commonly restart call numbering every reply; a stale decision buffered
//     from round N must never approve an unseen call in round N+1.
// ---------------------------------------------------------------------------

#[test]
fn a_reused_call_id_cannot_inherit_an_earlier_approval() {
    let h = harness(
        "reused-id",
        PermissionMode::AskWrites,
        10,
        "Write files, one approval at a time.",
    );
    let deadline = Instant::now() + DEADLINE;

    // Round 1: approved once, executed.
    h.wait_prompts(1, deadline);
    h.paste(&tool_block(
        "x1",
        "write_file",
        "{\"path\":\"first.txt\",\"content\":\"one\"}",
    ));
    h.wait_state(AgentState::AwaitingApproval, deadline);
    h.shared
        .cmd_tx
        .send(AgentCommand::Approve(vec![CallDecision {
            id: "x1".into(),
            approved: true,
        }]))
        .expect("approval channel is open");
    h.wait_prompts(2, deadline);
    assert!(h.ws_root.join("first.txt").exists(), "round 1 landed");

    // A decision that arrives while the agent waits for the model is buffered —
    // this is exactly how a late click from round 1 reaches round 2.
    h.shared
        .cmd_tx
        .send(AgentCommand::Approve(vec![CallDecision {
            id: "x1".into(),
            approved: true,
        }]))
        .expect("approval channel is open");

    // Round 2 reuses the SAME model id for a different file.
    h.paste(&tool_block(
        "x1",
        "write_file",
        "{\"path\":\"second.txt\",\"content\":\"two\"}",
    ));

    // Whichever way the race resolves, the stale decision must never execute
    // the unseen call: either the round waits for a FRESH decision, or it is
    // denied outright. Both are safe; execution is not an option.
    let mut waited_for_fresh = false;
    let poll_until = Instant::now() + Duration::from_secs(10);
    while Instant::now() < poll_until {
        if h.shared.current_state() == AgentState::AwaitingApproval {
            waited_for_fresh = true;
            break;
        }
        if h.snapshot().prompts.len() >= 3 {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        !h.ws_root.join("second.txt").exists(),
        "the buffered round-1 decision must not execute an unseen round-2 call"
    );

    if waited_for_fresh {
        // The fresh decision (keyed to this round's pending id) executes it.
        // The per-occurrence key for the SECOND use of "x1" is "2:x1"
        // (agent.rs increments the counter before formatting) — a decision
        // keyed "1:x1" would never match and this branch would hang/reject.
        h.shared
            .cmd_tx
            .send(AgentCommand::Approve(vec![CallDecision {
                id: "2:x1".into(),
                approved: true,
            }]))
            .expect("approval channel is open");
        h.wait_prompts(3, deadline);
        assert!(
            h.ws_root.join("second.txt").exists(),
            "the fresh approval landed on disk"
        );
        h.paste("DONE: both files written, one fresh approval each.");
    } else {
        // The round was denied outright instead: the model must be told the
        // truth, and nothing may have been written.
        let snap = h.snapshot();
        let prompts = snap.prompts;
        assert!(
            prompts.len() >= 3,
            "a result for round 2 was returned; states={:?}",
            snap.states
        );
        let r = result_payload(&prompts[2], "x1");
        assert_eq!(r["ok"], Value::Bool(false), "round 2 must not succeed: {r}");
        assert!(
            r["output"]
                .as_str()
                .unwrap_or("")
                .contains("rejected by the user"),
            "the denial is reported honestly: {r}"
        );
        h.paste("DONE: the second write was never approved.");
    }

    let state = h.wait_terminal(deadline);
    assert_eq!(state, AgentState::Done, "states: {:?}", h.snapshot().states);
}

// ---------------------------------------------------------------------------
// 9. Phase A: the unified action ledger records agent-route actions.
// ---------------------------------------------------------------------------

#[test]
fn action_ledger_records_agent_route_actions() {
    use neelima_lib::action::{ActionOutcome, ApprovalStatus, Executor, Intake, Proposer};

    let h = harness(
        "ledger",
        PermissionMode::AskWrites,
        12,
        "Create hello.txt then read it back.",
    );
    let deadline = Instant::now() + DEADLINE;

    // Round 1: write_file under AskWrites stops for an explicit approval.
    h.wait_prompts(1, deadline);
    h.paste(&tool_block(
        "w1",
        "write_file",
        "{\"path\":\"hello.txt\",\"content\":\"photon-torque-42\"}",
    ));
    h.wait_state(AgentState::AwaitingApproval, deadline);
    h.shared
        .cmd_tx
        .send(AgentCommand::Approve(vec![CallDecision {
            id: "w1".into(),
            approved: true,
        }]))
        .expect("approval channel is open");

    // Round 2: the read back is auto-approved under AskWrites.
    h.wait_prompts(2, deadline);
    h.paste(&tool_block("r1", "read_file", "{\"path\":\"hello.txt\"}"));

    // Round 3: DONE.
    h.wait_prompts(3, deadline);
    h.paste("DONE: file created and read back");
    h.wait_terminal(deadline);

    let task_id = h
        .shared
        .task_id
        .lock()
        .unwrap()
        .clone()
        .expect("task id recorded");
    let ledger = h.app.state::<Arc<neelima_lib::action::ActionLedger>>();
    let records: Vec<_> = ledger
        .snapshot()
        .into_iter()
        .filter(|r| r.task_id.as_deref() == Some(&task_id))
        .collect();
    assert_eq!(records.len(), 2, "one record per executed call");
    for record in &records {
        assert_eq!(record.origin.proposer, Proposer::Agent);
        assert_eq!(record.intake, Intake::AgentLoop);
        assert_eq!(record.schema_version, 1);
        assert!(
            record
                .request_id
                .as_deref()
                .unwrap_or_default()
                .starts_with(&task_id),
            "correlated to the task's provider request: {:?}",
            record.request_id
        );
        assert!(record.outcome.is_some(), "settled once the task finished");
    }

    let write = records
        .iter()
        .find(|r| r.descriptor.tool.as_deref() == Some("write_file"))
        .expect("write call recorded");
    assert!(
        write.approval.required,
        "AskWrites requires approval for writes"
    );
    assert_eq!(write.approval.status, ApprovalStatus::Approved);
    assert_eq!(write.approval.decision_source.as_deref(), Some("user_ui"));
    assert_eq!(write.outcome, Some(ActionOutcome::Succeeded));
    let execution = write.execution.as_ref().expect("write executed");
    assert_eq!(execution.executor, Executor::RustTools);
    assert!(execution.had_diff, "the write produced a diff");
    assert!(execution.output_len.unwrap_or(0) > 0);
    assert_eq!(write.descriptor.primary_path.as_deref(), Some("hello.txt"));
    // Metadata-only: the written content exists nowhere in the record.
    let serialized = serde_json::to_string(write).unwrap();
    assert!(
        !serialized.contains("photon-torque-42"),
        "file content leaked into the ledger: {serialized}"
    );

    let read = records
        .iter()
        .find(|r| r.descriptor.tool.as_deref() == Some("read_file"))
        .expect("read call recorded");
    assert!(!read.approval.required, "AskWrites auto-approves reads");
    assert_eq!(read.approval.status, ApprovalStatus::NotRequired);
    assert_eq!(read.outcome, Some(ActionOutcome::Succeeded));
    assert!(!read.execution.as_ref().unwrap().had_diff);
}
