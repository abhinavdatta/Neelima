//! The agent loop: an async state machine that teaches the provider the bridge
//! protocol, parses tool calls, asks for approval when the permission mode
//! demands it, executes tools with caps, and feeds results back until DONE.
//! Event-driven throughout: every wait point selects on the provider, the
//! approval channel, and the stop signal. No polling.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{Emitter, Manager};
use tokio::sync::{mpsc, Notify};

use crate::checkpoints;
use crate::exec;
use crate::history::{self, CallRecord, DiffInfo, HistoryStore, TranscriptEntry};
use crate::protocol::{self, Parsed, ToolCall};
use crate::providers::{ManualProvider, Provider, RelaySlot};
use crate::sec::{injection_heuristic, CommandGuard};
use crate::settings::Settings;
use crate::tools;
use crate::webprov::WebviewState;
use crate::workspace::Workspace;

pub const EVT: &str = "evt";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CallDecision {
    pub id: String,
    pub approved: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentState {
    Idle,
    WaitingForAi,
    Parsing,
    AwaitingApproval,
    Executing,
    Done,
    Error,
}

#[derive(Debug)]
pub enum AgentCommand {
    Approve(Vec<CallDecision>),
    Stop,
}

#[derive(Clone, serde::Serialize)]
struct AgentEvent {
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<AgentState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    entry: Option<TranscriptEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pending_calls: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

fn emit(app: &tauri::AppHandle, ev: AgentEvent) {
    let _ = app.emit(EVT, serde_json::to_value(ev).unwrap_or(Value::Null));
}

/// Handle for the currently running agent task (Stop / Approve entry points).
pub struct AgentShared {
    pub cmd_tx: mpsc::UnboundedSender<AgentCommand>,
    pub cmd_rx: Mutex<Option<mpsc::UnboundedReceiver<AgentCommand>>>,
    pub state: Mutex<AgentState>,
    pub task_id: Mutex<Option<String>>,
}

impl AgentShared {
    pub fn set_state(&self, s: AgentState) {
        *self.state.lock().unwrap() = s;
    }
    pub fn current_state(&self) -> AgentState {
        *self.state.lock().unwrap()
    }
}

#[derive(Default)]
pub struct ActiveAgent(pub Mutex<Option<Arc<AgentShared>>>);

impl ActiveAgent {
    pub fn get(&self) -> Option<Arc<AgentShared>> {
        self.0.lock().unwrap().clone()
    }
    pub fn clear(&self, task_id: &str) {
        let mut slot = self.0.lock().unwrap();
        if slot.as_ref().map(|s| s.task_id.lock().unwrap().as_deref() == Some(task_id)).unwrap_or(false) {
            *slot = None;
        }
    }
}

pub struct AgentInput {
    pub app: tauri::AppHandle,
    pub task_id: String,
    pub prompt: String,
    pub provider: Provider,
    pub ws: Workspace,
    pub settings: Settings,
    pub history: Arc<HistoryStore>,
    pub webview_state: Arc<WebviewState>,
    pub relay: Arc<RelaySlot>,
    pub shared: Arc<AgentShared>,
    pub prior_entries: Vec<TranscriptEntry>,
}

fn entry(kind: &str, text: String) -> TranscriptEntry {
    TranscriptEntry {
        id: 0,
        ts: history::now_ms(),
        kind: kind.into(),
        text,
        calls: Vec::new(),
        diff: None,
        injection_warning: None,
    }
}

fn call_risk(tool: &str) -> &'static str {
    match tool {
        "read_file" | "list_dir" | "glob" | "grep" => "read",
        "write_file" | "edit_file" | "delete_file" | "move_file" => "write",
        "run_command" => "command",
        _ => "other",
    }
}

const WRITE_TOOLS: &[&str] = &["write_file", "edit_file", "delete_file", "move_file"];

pub async fn run(mut input: AgentInput) {
    let app = input.app.clone();
    let shared = input.shared.clone();

    let stop = Arc::new(Notify::new());
    let halted = Arc::new(AtomicBool::new(false));

    // Router: UI commands -> stop signal / approval channel.
    let (approve_tx, mut approve_rx) = mpsc::unbounded_channel::<Vec<CallDecision>>();
    {
        let rx = shared.cmd_rx.lock().unwrap().take();
        if let Some(mut rx) = rx {
            let stop2 = stop.clone();
            let halted2 = halted.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(cmd) = rx.recv().await {
                    match cmd {
                        AgentCommand::Stop => {
                            halted2.store(true, Ordering::SeqCst);
                            stop2.notify_one(); // stored permit if nobody waits yet
                        }
                        AgentCommand::Approve(d) => {
                            let _ = approve_tx.send(d);
                        }
                    }
                }
            });
        }
    }

    let ws_name = input.ws.display_name();
    let mut meta = match input.history.create_task(
        input.prompt.lines().next().unwrap_or("task"),
        &ws_name,
        &input.provider.describe(),
    ) {
        Ok(m) => m,
        Err(e) => {
            finish_error(&shared, &app, &input.task_id, &format!("history error: {e}"));
            return;
        }
    };

    let history = input.history.clone();
    let task_id = input.task_id.clone();
    let push = |e: TranscriptEntry| -> TranscriptEntry {
        let mut e = e;
        e.id = history.next_entry_id();
        let _ = history.append(&task_id, &e);
        emit(&app, AgentEvent { kind: "transcript".into(), state: None, task_id: Some(task_id.clone()), entry: Some(e.clone()), pending_calls: None, text: None });
        e
    };

    if let Ok(cp) = checkpoints::snapshot(&input.ws, "task baseline") {
        push(entry("checkpoint", format!("checkpoint {} ({})", cp.id, cp.label)));
    }

    if !input.prior_entries.is_empty() {
        let mut summary = String::from("You are continuing a previous task in this workspace. Prior transcript (compressed):\n");
        for e in input.prior_entries.iter().rev().take(30).rev() {
            summary.push_str(&format!("[{}] {}\n", e.kind, protocol::truncate(&e.text, 400)));
        }
        push(entry("system", summary));
    }

    let tree = tree_summary(&input.ws, 2, 400);
    let preamble = protocol::preamble(&tree, &tools::tool_names(), input.settings.result_cap_bytes);
    push(entry("system", format!("protocol preamble sent to {}", input.provider.describe())));

    let guard = match CommandGuard::new(&input.settings.command_allow, &input.settings.command_deny) {
        Ok(g) => g,
        Err(e) => {
            push(entry("error", format!("command guard: {e}")));
            finish_error(&shared, &app, &input.task_id, &format!("command guard: {e}"));
            return;
        }
    };

    let mut iterations: u32 = 0;
    let mut parse_retries: u32 = 0;
    let mut nudge_count: u32 = 0;
    let mut consecutive_failures: u32 = 0;
    let mut last_failed_tool = String::new();

    let set_state = |s: AgentState| {
        shared.set_state(s);
        emit(&app, AgentEvent { kind: "agent-state".into(), state: Some(s), task_id: Some(task_id.clone()), pending_calls: None, text: None, entry: None });
    };

    // ---- first send: preamble + task --------------------------------------
    push(entry("user_prompt", input.prompt.clone()));
    let first_message = format!("{preamble}\n\n---\n\nTASK: {0}", input.prompt);
    set_state(AgentState::WaitingForAi);
    if let Err(e) = ensure_sent(&mut input, &first_message, &push).await {
        finish_error(&shared, &app, &input.task_id, &e);
        return;
    }

    loop {
        if halted.load(Ordering::SeqCst) {
            push(entry("system", "stopped by user".into()));
            finish(&shared, &app, &mut meta, &input, AgentState::Error, "stopped by user".into());
            input.app.state::<ActiveAgent>().clear(&input.task_id);
            return;
        }
        if iterations >= input.settings.max_iterations {
            finish_error(&shared, &app, &input.task_id, &format!("iteration limit ({}) reached", input.settings.max_iterations));
            input.app.state::<ActiveAgent>().clear(&input.task_id);
            return;
        }
        iterations += 1;
        meta.iterations = iterations;

        // ---- wait for the AI's reply --------------------------------------
        set_state(AgentState::WaitingForAi);
        let reply = tokio::select! {
            r = input.provider.wait_reply(stop.clone()) => match r {
                Ok(t) => t,
                Err(e) => {
                    finish_error(&shared, &app, &input.task_id, &e);
                    input.app.state::<ActiveAgent>().clear(&input.task_id);
                    return;
                }
            },
            _ = stop.notified() => { continue; }
            _ = approve_rx.recv() => { continue; }
        };

        set_state(AgentState::Parsing);
        push(TranscriptEntry {
            id: 0,
            ts: history::now_ms(),
            kind: "assistant".into(),
            text: protocol::truncate(&reply, 20_000).to_string(),
            calls: Vec::new(),
            diff: None,
            injection_warning: injection_heuristic(&reply),
        });

        match protocol::parse_reply(&reply) {
            Parsed::Done(summary) => {
                push(entry("done", summary.clone()));
                finish(&shared, &app, &mut meta, &input, AgentState::Done, summary);
                input.app.state::<ActiveAgent>().clear(&input.task_id);
                return;
            }
            Parsed::Error(e) => {
                parse_retries += 1;
                if parse_retries > 2 {
                    finish_error(&shared, &app, &input.task_id, &format!("malformed tool call 3 times; pausing. Last error: {e}"));
                    input.app.state::<ActiveAgent>().clear(&input.task_id);
                    return;
                }
                let correction = format!(
                    "Your last tool block was malformed and could not be parsed:\n{e}\nResend it as a correct ```tool block: one JSON object, double quotes, no trailing commas, fields id (string), tool, args."
                );
                push(entry("system", correction.clone()));
                if let Err(se) = ensure_sent(&mut input, &correction, &push).await {
                    finish_error(&shared, &app, &input.task_id, &se);
                    input.app.state::<ActiveAgent>().clear(&input.task_id);
                    return;
                }
                continue;
            }
            Parsed::Neither => {
                nudge_count += 1;
                if nudge_count > 3 {
                    push(entry("done", "no tool calls and no DONE — treating the reply as the final answer".into()));
                    finish(&shared, &app, &mut meta, &input, AgentState::Done, "final answer".into());
                    input.app.state::<ActiveAgent>().clear(&input.task_id);
                    return;
                }
                let nudge = "Reminder: reply with tool calls (```tool blocks) to act, or \"DONE: <summary>\" when the task is complete.";
                push(entry("system", nudge.into()));
                if let Err(se) = ensure_sent(&mut input, nudge, &push).await {
                    finish_error(&shared, &app, &input.task_id, &se);
                    input.app.state::<ActiveAgent>().clear(&input.task_id);
                    return;
                }
                continue;
            }
            Parsed::Calls(calls) => {
                parse_retries = 0;
                nudge_count = 0;

                // ---- approvals -----------------------------------------
                let needs_approval = |risk: &str| -> bool {
                    match risk {
                        "read" => !input.settings.permission_mode.auto_approve_read(),
                        "write" => !input.settings.permission_mode.auto_approve_write(),
                        "command" => !input.settings.permission_mode.auto_approve_command(),
                        _ => !input.settings.permission_mode.auto_approve_write(),
                    }
                };
                let any_needs = calls.iter().any(|c| needs_approval(call_risk(&c.tool)));
                let decisions: Vec<(ToolCall, bool)> = if any_needs {
                    set_state(AgentState::AwaitingApproval);
                    let mut pending = Vec::new();
                    for c in &calls {
                        let mut obj = json!({"id": c.id, "tool": c.tool, "args": c.args, "risk": call_risk(&c.tool)});
                        if WRITE_TOOLS.contains(&c.tool.as_str()) {
                            if let Some(d) = preview_diff(&input.ws, c) {
                                obj["diff"] = d;
                            }
                        }
                        pending.push(obj);
                    }
                    emit(&app, AgentEvent { kind: "approval-request".into(), state: Some(AgentState::AwaitingApproval), task_id: Some(task_id.clone()), entry: None, pending_calls: Some(pending), text: None });
                    let decisions = loop {
                        tokio::select! {
                            Some(d) = approve_rx.recv() => break d,
                            _ = stop.notified() => {
                                push(entry("system", "stopped by user during approval".into()));
                                finish(&shared, &app, &mut meta, &input, AgentState::Error, "stopped during approval".into());
                                input.app.state::<ActiveAgent>().clear(&input.task_id);
                                return;
                            }
                        }
                    };
                    calls.iter().map(|c| {
                        let approved = decisions.iter().find(|d| d.id == c.id).map(|d| d.approved).unwrap_or(false);
                        (c.clone(), approved)
                    }).collect()
                } else {
                    calls.iter().map(|c| (c.clone(), true)).collect()
                };

                // ---- execute -------------------------------------------
                set_state(AgentState::Executing);
                if decisions.iter().any(|(c, a)| *a && (WRITE_TOOLS.contains(&c.tool.as_str()) || c.tool == "run_command")) {
                    if let Ok(cp) = checkpoints::snapshot(&input.ws, "before tool batch") {
                        push(entry("checkpoint", format!("checkpoint {} ({})", cp.id, cp.label)));
                    }
                }

                let mut result_blocks = String::from("Results of your tool calls:\n");
                for (call, approved) in &decisions {
                    let mut record = CallRecord {
                        id: call.id.clone(),
                        tool: call.tool.clone(),
                        args: history::Value2(call.args.clone()),
                        status: "running".into(),
                        output: String::new(),
                    };
                    let (ok, output, diff): (bool, String, Option<DiffInfo>) = if !*approved {
                        record.status = "rejected".into();
                        (false, "rejected by the user".into(), None)
                    } else if call.tool == "run_command" {
                        let command = call.args.get("command").and_then(Value::as_str).unwrap_or("").to_string();
                        if let Err(e) = guard.check(&command) {
                            (false, format!("blocked: {e}"), None)
                        } else {
                            let cwd = call.args.get("cwd").and_then(Value::as_str).map(String::from);
                            let timeout = call.args.get("timeout").and_then(Value::as_u64).unwrap_or(input.settings.command_timeout_secs);
                            let app2 = app.clone();
                            let chunk_task = task_id.clone();
                            let call_id = call.id.clone();
                            let mut streamed_len = 0usize;
                            let out = exec::run_command_streaming(
                                &input.ws,
                                cwd.as_deref(),
                                &command,
                                timeout,
                                input.settings.result_cap_bytes,
                                stop.clone(),
                                move |chunk| {
                                    streamed_len += chunk.len();
                                    if streamed_len < 200_000 {
                                        let _ = app2.emit(EVT, json!({"kind": "command-output", "task_id": chunk_task, "call_id": call_id, "chunk": chunk}));
                                    }
                                },
                            ).await;
                            (out.ok, out.output, None)
                        }
                    } else {
                        let out = tools::execute(&input.ws, call, &input.settings);
                        let diff = out.diff.map(|(p, o, n)| DiffInfo { path: p, old: o, new: n });
                        (out.ok, out.output, diff)
                    };
                    if record.status != "rejected" {
                        record.status = if ok { "ok".into() } else { "error".into() };
                    }
                    record.output = protocol::truncate(&output, input.settings.result_cap_bytes).to_string();
                    result_blocks.push_str(&protocol::format_result(call, ok, &record.output));
                    let warning = injection_heuristic(&record.output);
                    push(TranscriptEntry { id: 0, ts: history::now_ms(), kind: "tool_calls".into(), text: String::new(), calls: vec![record], diff, injection_warning: warning });

                    if !ok && *approved {
                        consecutive_failures += 1;
                        last_failed_tool = call.tool.clone();
                    } else if ok {
                        consecutive_failures = 0;
                        last_failed_tool.clear();
                    }
                }

                if consecutive_failures >= 3 {
                    finish_error(&shared, &app, &input.task_id, &format!("circuit breaker: tool '{last_failed_tool}' failed 3 times in a row"));
                    input.app.state::<ActiveAgent>().clear(&input.task_id);
                    return;
                }

                set_state(AgentState::WaitingForAi);
                if let Err(e) = ensure_sent(&mut input, &result_blocks, &push).await {
                    finish_error(&shared, &app, &input.task_id, &e);
                    input.app.state::<ActiveAgent>().clear(&input.task_id);
                    return;
                }
            }
        }
    }
}

/// Send through the provider; on NEEDS_LOGIN fall back to manual relay once.
async fn ensure_sent(
    input: &mut AgentInput,
    text: &str,
    push: &impl Fn(TranscriptEntry) -> TranscriptEntry,
) -> Result<(), String> {
    if let Err(e) = input.provider.send(text).await {
        if e.contains("NEEDS_LOGIN") {
            input.provider = Provider::Manual(ManualProvider::new(input.app.clone(), input.relay.clone()));
            input.webview_state.manual_fallback_store(true);
            push(entry("system", "provider web chat needs login — switched to manual relay. Copy the message in the relay card into your chat, then paste the reply back.".into()));
            let _ = input.app.emit(EVT, json!({"kind": "manual-fallback", "task_id": input.task_id}));
            return input.provider.send(text).await;
        }
        return Err(e);
    }
    Ok(())
}

fn finish_error(shared: &Arc<AgentShared>, app: &tauri::AppHandle, task_id: &str, msg: &str) {
    shared.set_state(AgentState::Error);
    let _ = app.emit(EVT, serde_json::to_value(AgentEvent {
        kind: "agent-state".into(),
        state: Some(AgentState::Error),
        task_id: Some(task_id.into()),
        pending_calls: None,
        text: Some(msg.to_string()),
        entry: None,
    }).unwrap_or(Value::Null));
}

fn finish(shared: &Arc<AgentShared>, app: &tauri::AppHandle, meta: &mut history::TaskMeta, input: &AgentInput, state: AgentState, summary: String) {
    meta.status = format!("{state:?}").to_lowercase();
    meta.ended_ms = Some(history::now_ms());
    let _ = input.history.update_task(meta);
    shared.set_state(state);
    let _ = app.emit(EVT, serde_json::to_value(AgentEvent {
        kind: "agent-state".into(),
        state: Some(state),
        task_id: Some(input.task_id.clone()),
        pending_calls: None,
        text: Some(summary),
        entry: None,
    }).unwrap_or(Value::Null));
}

fn preview_diff(ws: &Workspace, call: &ToolCall) -> Option<serde_json::Value> {
    let path = call.args.get("path").and_then(Value::as_str)?;
    match call.tool.as_str() {
        "write_file" | "edit_file" => {
            let abs = ws.resolve(path).ok()?;
            let old = std::fs::read_to_string(&abs).unwrap_or_default();
            let new = match call.tool.as_str() {
                "write_file" => call.args.get("content").and_then(Value::as_str).unwrap_or("").to_string(),
                "edit_file" => {
                    let old_s = call.args.get("old_string").and_then(Value::as_str)?;
                    let new_s = call.args.get("new_string").and_then(Value::as_str)?;
                    let all = call.args.get("replace_all").and_then(Value::as_bool).unwrap_or(false);
                    if all { old.replace(old_s, new_s) } else { old.replacen(old_s, new_s, 1) }
                }
                _ => return None,
            };
            Some(json!({"path": path, "old": old, "new": new}))
        }
        _ => None,
    }
}

fn tree_summary(ws: &Workspace, depth: usize, max_entries: usize) -> String {
    let mut lines = Vec::new();
    walk(ws.root(), 0, depth, &mut lines, max_entries);
    if lines.is_empty() { "(empty workspace)".into() } else { lines.join("\n") }
}

fn walk(dir: &std::path::Path, level: usize, depth: usize, lines: &mut Vec<String>, max: usize) -> bool {
    if lines.len() >= max {
        return false;
    }
    let mut entries: Vec<_> = match std::fs::read_dir(dir) {
        Ok(rd) => rd.flatten().collect(),
        Err(_) => return true,
    };
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        if lines.len() >= max {
            lines.push("[tree truncated]".into());
            return false;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "node_modules" || name == "target" {
            continue;
        }
        let indent = "  ".repeat(level);
        if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            lines.push(format!("{indent}{name}/"));
            if level + 1 < depth && !walk(&e.path(), level + 1, depth, lines, max) {
                return false;
            }
        } else {
            lines.push(format!("{indent}{name}"));
        }
    }
    true
}
