//! The agent loop: an async state machine that teaches the provider the bridge
//! protocol, parses tool calls, asks for approval when the permission mode
//! demands it, executes tools with caps, and feeds results back until DONE.
//! Event-driven throughout: every wait point selects on the provider, the
//! approval channel, and the stop signal. No polling.

use std::collections::HashMap;
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
use crate::providers::Provider;
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
    Cancelled,
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
        if slot
            .as_ref()
            .map(|s| s.task_id.lock().unwrap().as_deref() == Some(task_id))
            .unwrap_or(false)
        {
            *slot = None;
        }
    }
}

pub struct AgentInput {
    pub app: tauri::AppHandle,
    pub task_id: String,
    pub conversation_id: String,
    pub prompt: String,
    pub skill_context: String,
    /// Step 3: which workspace files may be attached, and which the user vetoed.
    pub context: crate::context::Options,
    pub provider: Provider,
    pub ws: Workspace,
    pub settings: Settings,
    pub history: Arc<HistoryStore>,
    pub webview_state: Arc<WebviewState>,
    pub shared: Arc<AgentShared>,
    pub prior_entries: Vec<TranscriptEntry>,
}

/// Metadata-only summary of the project context attached to this task. It
/// names the files (provenance) but never their contents.
fn context_note(sel: &crate::context::Selection) -> String {
    let skipped = &sel.skipped;
    let mut skips: Vec<String> = Vec::new();
    if skipped.binary > 0 {
        skips.push(format!("{} binary", skipped.binary));
    }
    if skipped.oversized > 0 {
        skips.push(format!("{} oversized", skipped.oversized));
    }
    if skipped.unreadable > 0 {
        skips.push(format!("{} unreadable", skipped.unreadable));
    }
    if skipped.outside > 0 {
        skips.push(format!("{} outside the workspace", skipped.outside));
    }
    let skip_text = if skips.is_empty() {
        String::new()
    } else {
        format!("; skipped {}", skips.join(", "))
    };
    if sel.files.is_empty() {
        return format!(
            "Project context: no workspace file matched this prompt, so it was sent without file contents ({} files scanned{skip_text}).",
            sel.considered
        );
    }
    let shown: Vec<&str> = sel.files.iter().take(6).map(|f| f.path.as_str()).collect();
    let extra = sel.files.len().saturating_sub(shown.len());
    format!(
        "Project context: {} file(s), {} of {} budget{} from {} files scanned{skip_text}. Included: {}{}.",
        sel.files.len(),
        crate::context::human_bytes(sel.bytes),
        crate::context::human_bytes(sel.budget_bytes),
        if sel.truncated {
            " — truncated to the provider budget"
        } else {
            ""
        },
        sel.considered,
        shown.join(", "),
        if extra > 0 {
            format!(" and {extra} more")
        } else {
            String::new()
        }
    )
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

fn tool_needs_approval(
    tool: &str,
    args: &Value,
    mode: crate::settings::PermissionMode,
    guard: &CommandGuard,
) -> bool {
    if tool == "run_command" {
        let command = args.get("command").and_then(Value::as_str).unwrap_or("");
        if guard.needs_ask(command) {
            return true;
        }
    }
    // Phase B: one shared risk→approval mapping for both routes — the bridge
    // cannot drift from the agent's policy because this IS the agent's policy.
    crate::action::approval_required(crate::action::risk_of_tool(tool), mode)
}

const WRITE_TOOLS: &[&str] = &["write_file", "edit_file", "delete_file", "move_file"];

fn completion_reports_unavailable_tools(summary: &str) -> bool {
    let summary = summary.to_ascii_lowercase();
    summary.contains("tool")
        && [
            "not available",
            "unavailable",
            "not accessible",
            "cannot access",
            "unable to access",
        ]
        .iter()
        .any(|phrase| summary.contains(phrase))
}

// ---------------------------------------------------------------------------
// Phase A: unified action ledger (observational — never an authorization input)
// ---------------------------------------------------------------------------

/// Mint + validate the ledger record for one call of the current batch and,
/// when the approval decision is already known, record it. Returns `None`
/// when no ledger is managed (some tests) — recording must never be
/// load-bearing, and every decision below is still made by the existing
/// approval/execution code.
#[allow(clippy::too_many_arguments)]
fn record_action_begin(
    app: &tauri::AppHandle,
    task_id: &str,
    request_id: Option<&str>,
    call: &ToolCall,
    approved: bool,
    approval_required: bool,
    mode: crate::settings::PermissionMode,
    provider: &str,
) -> Option<String> {
    let ledger = crate::action::ledger_of(app)?;
    let risk = crate::action::risk_of_tool(&call.tool);
    let begin = crate::action::BeginAction {
        origin: crate::action::ActionOrigin {
            proposer: crate::action::Proposer::Agent,
            provider: Some(provider.to_string()),
            site: None,
            page_origin: None,
        },
        intake: crate::action::Intake::AgentLoop,
        category: crate::action::category_of_tool(&call.tool),
        tool: Some(&call.tool),
        risk,
        args: Some(&call.args),
        task_id: Some(task_id),
        request_id,
        transport_request_id: None,
        approval_required,
        approval_reason: Some(format!("mode={mode:?} risk={risk:?}")),
    };
    let action_id = ledger.begin(&begin)?;
    let _ = ledger.validate(&action_id);
    if approval_required {
        let _ = ledger.await_approval(&action_id);
        if approved {
            let _ = ledger.decide_approval(&action_id, true);
        }
    }
    Some(action_id)
}

/// A call the user did not approve. When approval was required this is a real
/// rejection; in a mixed batch a call that did not need approval can also end
/// up unapproved (the user acted only on the risky one) — recorded as such.
fn action_record_not_approved(
    app: &tauri::AppHandle,
    action_id: Option<&str>,
    approval_required: bool,
) {
    let (Some(ledger), Some(action_id)) = (crate::action::ledger_of(app), action_id) else {
        return;
    };
    if approval_required {
        let _ = ledger.decide_approval(action_id, false);
    } else {
        let _ = ledger.refuse(action_id, crate::action::category::NOT_APPROVED);
    }
}

fn action_record_refused(app: &tauri::AppHandle, action_id: Option<&str>, category: &str) {
    let (Some(ledger), Some(action_id)) = (crate::action::ledger_of(app), action_id) else {
        return;
    };
    let _ = ledger.refuse(action_id, category);
}

/// The approval gate passed and the tool is about to run.
fn action_record_execution_started(
    app: &tauri::AppHandle,
    action_id: Option<&str>,
    executor: crate::action::Executor,
) {
    let (Some(ledger), Some(action_id)) = (crate::action::ledger_of(app), action_id) else {
        return;
    };
    let _ = ledger.begin_execution(action_id, executor);
}

fn action_record_tool_settled(
    app: &tauri::AppHandle,
    action_id: Option<&str>,
    ok: bool,
    output_len: usize,
    had_diff: bool,
) {
    let (Some(ledger), Some(action_id)) = (crate::action::ledger_of(app), action_id) else {
        return;
    };
    let outcome = if ok {
        crate::action::ActionOutcome::Succeeded
    } else {
        crate::action::ActionOutcome::Failed
    };
    let _ = ledger.settle(
        action_id,
        outcome,
        crate::action::ExecutionMeta {
            output_len: Some(output_len),
            had_diff,
            ..Default::default()
        },
        (!ok).then_some(crate::action::category::TOOL_ERROR),
    );
}

fn action_record_command_settled(
    app: &tauri::AppHandle,
    action_id: Option<&str>,
    ok: bool,
    output_len: usize,
    exit_code: Option<i32>,
    timed_out: bool,
    killed: bool,
) {
    let (Some(ledger), Some(action_id)) = (crate::action::ledger_of(app), action_id) else {
        return;
    };
    let outcome = if timed_out {
        crate::action::ActionOutcome::TimedOut
    } else if killed {
        crate::action::ActionOutcome::Cancelled
    } else if ok {
        crate::action::ActionOutcome::Succeeded
    } else {
        crate::action::ActionOutcome::Failed
    };
    let _ = ledger.settle(
        action_id,
        outcome,
        crate::action::ExecutionMeta {
            output_len: Some(output_len),
            exit_code,
            process_timed_out: timed_out,
            process_killed: killed,
            ..Default::default()
        },
        (!ok && !timed_out && !killed).then_some(crate::action::category::TOOL_ERROR),
    );
}

pub async fn run(mut input: AgentInput) {
    let app = input.app.clone();
    let shared = input.shared.clone();
    let _lifecycle = AgentLifecycleGuard::start(
        app.clone(),
        input.task_id.clone(),
        shared.clone(),
        input.history.clone(),
        input.webview_state.clone(),
    );

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
    // Approval decisions can arrive while the loop is still in WaitingForAi
    // (the user clicks before the agent re-enters the approval wait). Buffer
    // them here so no decision is ever dropped; each is applied to the next
    // pending batch it matches. Decisions left over after a batch belong to a
    // different round and are ignored on purpose (per-batch approval).
    let mut buffered_decisions: Vec<CallDecision> = Vec::new();
    let mut meta = match input.history.create_task_in_conversation(
        &input.task_id,
        &input.conversation_id,
        input.prompt.lines().next().unwrap_or("task"),
        &ws_name,
        &input.provider.describe(),
    ) {
        Ok(m) => m,
        Err(e) => {
            finish_error(
                &shared,
                &app,
                &input.task_id,
                &format!("history error: {e}"),
            );
            return;
        }
    };

    let history = input.history.clone();
    let task_id = input.task_id.clone();
    let push = |e: TranscriptEntry| -> TranscriptEntry {
        let mut e = e;
        e.id = history.next_entry_id();
        match history.append_once(&task_id, &e) {
            Ok(true) => emit(
                &app,
                AgentEvent {
                    kind: "transcript".into(),
                    state: None,
                    task_id: Some(task_id.clone()),
                    entry: Some(e.clone()),
                    pending_calls: None,
                    text: None,
                },
            ),
            Ok(false) => {}
            Err(error) => {
                let _ = app.emit(
                    EVT,
                    json!({
                        "kind": "notify",
                        "level": "error",
                        "text": format!("Could not save task transcript: {error}"),
                    }),
                );
            }
        }
        e
    };

    if let Ok(cp) = checkpoints::snapshot(&input.ws, "task baseline") {
        push(entry(
            "checkpoint",
            format!("checkpoint {} ({})", cp.id, cp.label),
        ));
    }

    if !input.prior_entries.is_empty() {
        let mut summary = String::from("You are continuing a previous task in this workspace. Prior transcript (compressed):\n");
        for e in input.prior_entries.iter().rev().take(30).rev() {
            summary.push_str(&format!(
                "[{}] {}\n",
                e.kind,
                protocol::truncate(&e.text, 400)
            ));
        }
        push(entry("system", summary));
    }

    let tree = format!(
        "Workspace root: {}\n{}",
        input.ws.root().display(),
        tree_summary(&input.ws, 2, 400)
    );
    // B4: per-task tool-call nonce. Manual relay stays nonce-free (a human
    // copies/pastes; blocks would not carry the nonce).
    let task_nonce: Option<String> = match input.provider {
        Provider::Manual(_) => None,
        Provider::Web(_) | Provider::Local(_) => {
            let full = uuid::Uuid::new_v4().simple().to_string();
            Some(full[..8].to_string())
        }
    };
    let preamble = protocol::preamble(
        &tree,
        &tools::tool_names(),
        input.settings.result_cap_bytes,
        task_nonce.as_deref(),
    );
    push(entry(
        "system",
        format!("protocol preamble sent to {}", input.provider.describe()),
    ));
    if !input.skill_context.is_empty() {
        push(entry(
            "system",
            "Selected skills were added to this task as untrusted reference content.".into(),
        ));
    }

    // ---- Step 3: project context -----------------------------------------
    // Selection happens BEFORE the first send and is read-only. The prompt is
    // unaffected when nothing is selected, so Step 2 behaviour is preserved
    // byte-for-byte for no-context prompts.
    let context_selection = {
        let prior_prompts: Vec<String> = input
            .prior_entries
            .iter()
            .filter(|e| e.kind == "user_prompt")
            .map(|e| e.text.clone())
            .collect();
        let query = crate::context::query_for(&input.prompt, &prior_prompts);
        crate::context::select_for(
            &input.ws,
            &query,
            &input.settings,
            input.provider.context_kind(),
            &input.context,
        )
    };
    if input.context.enabled {
        let note = context_note(&context_selection);
        // Metadata only: counts, budget and paths — never file contents.
        let _ = crate::app_log::write(
            "context",
            &format!(
                "files={} considered={} bytes={} budget={} truncated={} scan_capped={} omitted={} excluded_by_user={} binary={} oversized={} unreadable={}",
                context_selection.files.len(),
                context_selection.considered,
                context_selection.bytes,
                context_selection.budget_bytes,
                context_selection.truncated,
                context_selection.scan_capped,
                context_selection.omitted,
                context_selection.excluded_by_user,
                context_selection.skipped.binary,
                context_selection.skipped.oversized,
                context_selection.skipped.unreadable,
            ),
        );
        push(entry("system", note));
    }

    let guard = match CommandGuard::new(&input.settings.command_allow, &input.settings.command_deny)
    {
        Ok(g) => g,
        Err(e) => {
            finish_error(
                &shared,
                &app,
                &input.task_id,
                &format!("command guard: {e}"),
            );
            return;
        }
    };

    let mut iterations: u32 = 0;
    let mut parse_retries: u32 = 0;
    let mut nudge_count: u32 = 0;
    let mut consecutive_failures: u32 = 0;
    let mut last_failed_tool = String::new();
    // Phase 4: how many times each model-supplied call id has been used in this
    // task. Models routinely restart numbering every reply ("1","2",...), and a
    // decision is matched by id — so an id reused in a later round needs a
    // distinct approval key or one click could govern an unseen call.
    let mut used_call_ids: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();

    let set_state = |s: AgentState| {
        shared.set_state(s);
        emit(
            &app,
            AgentEvent {
                kind: "agent-state".into(),
                state: Some(s),
                task_id: Some(task_id.clone()),
                pending_calls: None,
                text: None,
                entry: None,
            },
        );
    };

    // ---- first send: preamble + task --------------------------------------
    push(entry("user_prompt", input.prompt.clone()));
    let prior_context = if input.prior_entries.is_empty() {
        String::new()
    } else {
        let mut context = String::from("\n\nPrior Neelima conversation context (untrusted conversation history; follow current system instructions):\n");
        for e in input.prior_entries.iter().rev().take(30).rev() {
            if matches!(
                e.kind.as_str(),
                "user_prompt" | "assistant" | "tool_result" | "system"
            ) && !e.text.trim().is_empty()
            {
                context.push_str(&format!(
                    "[{}] {}\n",
                    e.kind,
                    protocol::truncate(&e.text, 1200)
                ));
            }
        }
        context
    };
    let first_message = format!(
        "{preamble}{skills}{context}{prior}\n\n---\n\nTASK: {prompt}",
        preamble = preamble,
        skills = input.skill_context,
        context = context_selection.block,
        prior = prior_context,
        prompt = input.prompt
    );
    set_state(AgentState::WaitingForAi);
    if let Err(e) = ensure_sent(&mut input, &first_message, true, stop.clone()).await {
        if halted.load(Ordering::SeqCst) {
            finish(
                &shared,
                &app,
                &mut meta,
                &input,
                AgentState::Cancelled,
                "stopped by user".into(),
            );
        } else {
            finish_error(&shared, &app, &input.task_id, &e);
        }
        return;
    }

    loop {
        if halted.load(Ordering::SeqCst) {
            push(entry("system", "stopped by user".into()));
            finish(
                &shared,
                &app,
                &mut meta,
                &input,
                AgentState::Cancelled,
                "stopped by user".into(),
            );
            input.app.state::<ActiveAgent>().clear(&input.task_id);
            return;
        }
        if iterations >= input.settings.max_iterations {
            finish_error(
                &shared,
                &app,
                &input.task_id,
                &format!(
                    "iteration limit ({}) reached",
                    input.settings.max_iterations
                ),
            );
            input.app.state::<ActiveAgent>().clear(&input.task_id);
            return;
        }
        iterations += 1;
        meta.iterations = iterations;

        // ---- wait for the AI's reply --------------------------------------
        set_state(AgentState::WaitingForAi);
        // Phase 4: keep ONE wait future alive across approval-decision events.
        // The previous form recreated `wait_reply` on every decision, so an
        // approval that raced a freshly pasted reply dropped the waiter AFTER
        // `deliver` had already reported success — the reply was acknowledged
        // and then silently discarded. Holding the future across iterations
        // keeps the provider/relay waiter armed for the whole round.
        enum WaitOutcome {
            Reply(Result<String, String>),
            Stop,
        }
        let outcome = {
            let waiting = input.provider.wait_reply(stop.clone());
            tokio::pin!(waiting);
            loop {
                tokio::select! {
                    r = &mut waiting => break WaitOutcome::Reply(r),
                    _ = stop.notified() => break WaitOutcome::Stop,
                    Some(d) = approve_rx.recv() => {
                        buffered_decisions.extend(d);
                    }
                }
            }
        };
        let reply = match outcome {
            WaitOutcome::Stop => continue,
            WaitOutcome::Reply(Ok(t)) => t,
            WaitOutcome::Reply(Err(e)) => {
                if halted.load(Ordering::SeqCst) || e == "stopped" {
                    finish(
                        &shared,
                        &app,
                        &mut meta,
                        &input,
                        AgentState::Cancelled,
                        "stopped by user".into(),
                    );
                } else {
                    finish_error(&shared, &app, &input.task_id, &e);
                }
                input.app.state::<ActiveAgent>().clear(&input.task_id);
                return;
            }
        };

        set_state(AgentState::Parsing);
        let parsed = protocol::parse_reply(&reply, task_nonce.as_deref());
        let visible_reply = protocol::display_reply(&reply, &parsed);
        if !visible_reply.is_empty() {
            push(TranscriptEntry {
                id: 0,
                ts: history::now_ms(),
                kind: "assistant".into(),
                text: protocol::truncate(&visible_reply, 20_000).to_string(),
                calls: Vec::new(),
                diff: None,
                injection_warning: injection_heuristic(&reply),
            });
        }

        match parsed {
            Parsed::Done(summary) => {
                if completion_reports_unavailable_tools(&summary) {
                    let error = format!(
                        "The provider reported that Neelima's workspace tools are unavailable, so this task did not complete: {summary}. Confirm a workspace is open and start the task from Neelima's composer."
                    );
                    finish_error(&shared, &app, &input.task_id, &error);
                    input.app.state::<ActiveAgent>().clear(&input.task_id);
                    return;
                }
                push(entry("done", "Completed".into()));
                // Phase 3O: ground the summary in the ledger. The model's text
                // is never proof of execution; the check runs BEFORE the task
                // record closes so cancelled/unsettled work cannot be laundered
                // by the final message.
                if let Some(note) = summarize_write_claims(
                    &summary,
                    &crate::action::ledger_of(&app)
                        .map(|l| l.file_ops_for_task(&input.task_id))
                        .unwrap_or_default(),
                ) {
                    push(entry("system", note));
                }
                finish(&shared, &app, &mut meta, &input, AgentState::Done, summary);
                input.app.state::<ActiveAgent>().clear(&input.task_id);
                return;
            }
            Parsed::Error(e) => {
                parse_retries += 1;
                if parse_retries > 2 {
                    finish_error(
                        &shared,
                        &app,
                        &input.task_id,
                        &format!("malformed tool call 3 times; pausing. Last error: {e}"),
                    );
                    input.app.state::<ActiveAgent>().clear(&input.task_id);
                    return;
                }
                let correction = format!(
                    "Your last tool block was malformed and could not be parsed:\n{e}\nResend it as a correct ```tool block: one JSON object, double quotes, no trailing commas, fields id (string), tool, args."
                );
                push(entry("system", correction.clone()));
                if let Err(se) = ensure_sent(&mut input, &correction, false, stop.clone()).await {
                    if halted.load(Ordering::SeqCst) {
                        finish(
                            &shared,
                            &app,
                            &mut meta,
                            &input,
                            AgentState::Cancelled,
                            "stopped by user".into(),
                        );
                    } else {
                        finish_error(&shared, &app, &input.task_id, &se);
                    }
                    input.app.state::<ActiveAgent>().clear(&input.task_id);
                    return;
                }
                continue;
            }
            Parsed::Neither => {
                nudge_count += 1;
                if nudge_count > 3 {
                    push(entry(
                        "done",
                        "no tool calls and no DONE — treating the reply as the final answer".into(),
                    ));
                    finish(
                        &shared,
                        &app,
                        &mut meta,
                        &input,
                        AgentState::Done,
                        "final answer".into(),
                    );
                    input.app.state::<ActiveAgent>().clear(&input.task_id);
                    return;
                }
                let nudge = "Reminder: reply with tool calls (```tool blocks) to act, or \"DONE: <summary>\" when the task is complete.";
                push(entry("system", nudge.into()));
                if let Err(se) = ensure_sent(&mut input, nudge, false, stop.clone()).await {
                    if halted.load(Ordering::SeqCst) {
                        finish(
                            &shared,
                            &app,
                            &mut meta,
                            &input,
                            AgentState::Cancelled,
                            "stopped by user".into(),
                        );
                    } else {
                        finish_error(&shared, &app, &input.task_id, &se);
                    }
                    input.app.state::<ActiveAgent>().clear(&input.task_id);
                    return;
                }
                continue;
            }
            Parsed::Calls(calls) => {
                parse_retries = 0;
                nudge_count = 0;

                // ---- approvals -----------------------------------------
                let needs_approval = |c: &ToolCall| {
                    tool_needs_approval(&c.tool, &c.args, input.settings.permission_mode, &guard)
                };
                let any_needs = calls.iter().any(needs_approval);
                // Unique approval key per call occurrence in this task (first use
                // keeps the model's id, later uses are prefixed with the count).
                let approval_keys: Vec<String> = calls
                    .iter()
                    .map(|c| {
                        let count = used_call_ids.entry(c.id.clone()).or_insert(0);
                        *count += 1;
                        if *count == 1 {
                            c.id.clone()
                        } else {
                            format!("{count}:{}", c.id)
                        }
                    })
                    .collect();
                // CP6: the exact preview-time snapshot for every guardable call
                // in this approval batch (keyed by the unique approval key).
                let mut approval_baselines: HashMap<String, (String, PreviewBaseline)> =
                    HashMap::new();
                let decisions: Vec<(ToolCall, bool, String)> = if any_needs {
                    set_state(AgentState::AwaitingApproval);
                    let mut pending = Vec::new();
                    for (c, key) in calls.iter().zip(&approval_keys) {
                        // Capture BEFORE building the preview, so the guard is
                        // never weaker than the content the user is shown.
                        if let (Some(baseline), Some(path)) = (
                            capture_preview_baseline(&input.ws, c),
                            c.args.get("path").and_then(Value::as_str),
                        ) {
                            // Canonical display form, so a same-batch second
                            // call spelled differently still matches the
                            // refreshed baseline for the same file.
                            let canonical = input
                                .ws
                                .resolve(path)
                                .map(|abs| input.ws.display(&abs))
                                .unwrap_or_else(|_| path.to_string());
                            approval_baselines.insert(key.clone(), (canonical, baseline));
                        }
                        let mut obj = json!({"id": key, "tool": c.tool, "args": c.args, "risk": call_risk(&c.tool)});
                        if WRITE_TOOLS.contains(&c.tool.as_str()) {
                            if let Some(d) = preview_diff(&input.ws, c) {
                                obj["diff"] = d;
                            }
                        }
                        pending.push(obj);
                    }
                    emit(
                        &app,
                        AgentEvent {
                            kind: "approval-request".into(),
                            state: Some(AgentState::AwaitingApproval),
                            task_id: Some(task_id.clone()),
                            entry: None,
                            pending_calls: Some(pending),
                            text: None,
                        },
                    );
                    let decisions = tokio::select! {
                        Some(d) = approve_rx.recv() => d,
                        _ = stop.notified() => {
                            push(entry("system", "stopped by user during approval".into()));
                            finish(&shared, &app, &mut meta, &input, AgentState::Cancelled, "stopped during approval".into());
                            input.app.state::<ActiveAgent>().clear(&input.task_id);
                            return;
                        }
                    };
                    // Merge early decisions buffered while WaitingForAi: a
                    // decision delivered before this wait must still count.
                    let merged = {
                        let mut all = buffered_decisions.clone();
                        all.extend(decisions);
                        all
                    };
                    buffered_decisions.clear();
                    calls
                        .iter()
                        .zip(&approval_keys)
                        .map(|(c, key)| {
                            let approved = merged
                                .iter()
                                .find(|d| &d.id == key)
                                .map(|d| d.approved)
                                .unwrap_or(false);
                            (c.clone(), approved, key.clone())
                        })
                        .collect()
                } else {
                    // No approval batch: no human preview to protect. Existing
                    // tool semantics stand unchanged.
                    calls
                        .iter()
                        .map(|c| (c.clone(), true, String::new()))
                        .collect()
                };

                // ---- execute -------------------------------------------
                set_state(AgentState::Executing);
                if decisions.iter().any(|(c, a, _)| {
                    *a && (WRITE_TOOLS.contains(&c.tool.as_str()) || c.tool == "run_command")
                }) {
                    if let Ok(cp) = checkpoints::snapshot(&input.ws, "before tool batch") {
                        push(entry(
                            "checkpoint",
                            format!("checkpoint {} ({})", cp.id, cp.label),
                        ));
                    }
                }

                let mut result_blocks = String::from("Results of your tool calls:\n");
                // Phase A: correlate this batch to the task's most recent
                // provider request (it has usually already completed by the
                // time tools run — unlike live_for_task, this survives that).
                let ledger_request_id = app
                    .try_state::<std::sync::Arc<crate::request::RequestRegistry>>()
                    .and_then(|registry| registry.latest_for_task(&task_id));
                for (call, approved, approval_key) in &decisions {
                    let approval_required = tool_needs_approval(
                        &call.tool,
                        &call.args,
                        input.settings.permission_mode,
                        &guard,
                    );
                    let action_id = record_action_begin(
                        &app,
                        &task_id,
                        ledger_request_id.as_deref(),
                        call,
                        *approved,
                        approval_required,
                        input.settings.permission_mode,
                        &input.provider.describe(),
                    );
                    let started_ms = history::now_ms();
                    let mut record = CallRecord {
                        id: call.id.clone(),
                        tool: call.tool.clone(),
                        args: history::Value2(call.args.clone()),
                        status: "running".into(),
                        output: String::new(),
                        action_id: action_id.clone(),
                        // Only a call that actually reaches an executor gets a
                        // start timestamp; rejected/refused calls never begin.
                        started_ms: None,
                        duration_ms: None,
                        exit_code: None,
                    };
                    let (ok, output, diff): (bool, String, Option<DiffInfo>) = if !*approved {
                        record.status = "rejected".into();
                        action_record_not_approved(&app, action_id.as_deref(), approval_required);
                        (false, "rejected by the user".into(), None)
                    } else if call.tool == "run_command" {
                        let command = call
                            .args
                            .get("command")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        // Phase C: typed argument validation from the shared
                        // registry — a missing or non-string command fails
                        // closed without spawning anything. Out-of-range
                        // timeouts stay a clamp (executor) by design.
                        if let Err(e) = crate::tools::validate_tool_args("run_command", &call.args)
                        {
                            record.status = "refused".into();
                            action_record_refused(
                                &app,
                                action_id.as_deref(),
                                crate::action::category::INVALID_ARGS,
                            );
                            (false, format!("run_command: invalid arguments: {e}"), None)
                        } else if let Err(e) = guard.check(&command) {
                            record.status = "refused".into();
                            action_record_refused(
                                &app,
                                action_id.as_deref(),
                                crate::action::category::GUARD_DENIED,
                            );
                            (false, format!("blocked: {e}"), None)
                        } else {
                            let cwd = call
                                .args
                                .get("cwd")
                                .and_then(Value::as_str)
                                .map(String::from);
                            action_record_execution_started(
                                &app,
                                action_id.as_deref(),
                                crate::action::Executor::RustExec,
                            );
                            record.started_ms = Some(started_ms);
                            // Phase 4: both sources of this value are untrusted
                            // (model args and a hand-edited settings file), so the
                            // clamp happens here as well as inside exec.
                            let requested = call
                                .args
                                .get("timeout")
                                .and_then(Value::as_u64)
                                .or(Some(input.settings.command_timeout_secs));
                            let timeout = exec::clamp_timeout(requested);
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
                            action_record_command_settled(
                                &app,
                                action_id.as_deref(),
                                out.ok,
                                out.output.len(),
                                out.exit_code,
                                out.timed_out,
                                out.killed,
                            );
                            record.exit_code = out.exit_code;
                            record.status = if out.timed_out {
                                "timed_out".into()
                            } else if out.killed {
                                "cancelled".into()
                            } else if out.ok {
                                "ok".into()
                            } else {
                                "error".into()
                            };
                            (out.ok, out.output, None)
                        }
                    } else {
                        // CP6 stale-baseline guard: only calls carrying a
                        // preview-time snapshot (i.e. human-reviewed calls) are
                        // checked. A mismatch refuses the call; the existing
                        // tool executor is never reached, so nothing is
                        // written and no second save path exists.
                        let refusal = approval_baselines.get(approval_key).and_then(
                            |(_, baseline)| {
                                preview_baseline_conflict(&input.ws, call, baseline).map(
                                    |message| {
                                        // A >2 MB/unreadable destination has no
                                        // captured baseline: the approved call is
                                        // refused (fail closed), not treated as
                                        // permission to overwrite.
                                        let category = if matches!(
                                            baseline,
                                            PreviewBaseline::Unavailable
                                        ) {
                                            crate::action::category::BASELINE_UNAVAILABLE
                                        } else {
                                            crate::action::category::STALE_BASELINE
                                        };
                                        (message, category)
                                    },
                                )
                            },
                        );
                        if let Some((message, category)) = refusal {
                            record.status = "refused".into();
                            action_record_refused(&app, action_id.as_deref(), category);
                            (false, message, None)
                        } else {
                            action_record_execution_started(
                                &app,
                                action_id.as_deref(),
                                crate::action::Executor::RustTools,
                            );
                            record.started_ms = Some(started_ms);
                            let out = tools::execute(&input.ws, call, &input.settings);
                            action_record_tool_settled(
                                &app,
                                action_id.as_deref(),
                                out.ok,
                                out.output.len(),
                                out.diff.is_some(),
                            );
                            if out.ok {
                                if let Some((path, _)) = approval_baselines.get(approval_key) {
                                    let path = path.clone();
                                    refresh_preview_baselines(
                                        &input.ws,
                                        &path,
                                        &mut approval_baselines,
                                    );
                                }
                                // CP6: a verified write is the only event that
                                // may refresh the explorer or reconcile an
                                // editor tab. It fires from the REAL tool
                                // outcome (whose disk read-back already ran),
                                // never from a model claim, and only for bytes
                                // that actually changed.
                                if write_changed_bytes(call, &out) {
                                    let workspace =
                                        input.ws.root().to_string_lossy().into_owned();
                                    for path in changed_paths(&input.ws, call) {
                                        let _ = app.emit(
                                            EVT,
                                            json!({
                                                "kind": "file-changed",
                                                "task_id": input.task_id,
                                                "call_id": call.id,
                                                "action_id": action_id,
                                                "tool": call.tool,
                                                "path": path,
                                                "workspace": workspace,
                                                "verified": true,
                                            }),
                                        );
                                    }
                                }
                            }
                            record.status = if out.ok { "ok".into() } else { "error".into() };
                            let diff = out.diff.map(|(p, o, n)| DiffInfo {
                                path: p,
                                old: o,
                                new: n,
                            });
                            (out.ok, out.output, diff)
                        }
                    };
                    if record.started_ms.is_some() {
                        record.duration_ms =
                            Some(history::now_ms().saturating_sub(started_ms));
                    }
                    if record.status == "running" {
                        record.status = if ok { "ok".into() } else { "error".into() };
                    }
                    record.output =
                        protocol::truncate(&output, input.settings.result_cap_bytes).to_string();
                    result_blocks.push_str(&protocol::format_result(call, ok, &record.output));
                    let warning = injection_heuristic(&record.output);
                    push(TranscriptEntry {
                        id: 0,
                        ts: history::now_ms(),
                        kind: "tool_calls".into(),
                        text: String::new(),
                        calls: vec![record],
                        diff,
                        injection_warning: warning,
                    });

                    if !ok && *approved {
                        consecutive_failures += 1;
                        last_failed_tool = call.tool.clone();
                    } else if ok {
                        consecutive_failures = 0;
                        last_failed_tool.clear();
                    }
                }

                if consecutive_failures >= 3 {
                    finish_error(
                        &shared,
                        &app,
                        &input.task_id,
                        &format!(
                            "circuit breaker: tool '{last_failed_tool}' failed 3 times in a row"
                        ),
                    );
                    input.app.state::<ActiveAgent>().clear(&input.task_id);
                    return;
                }

                set_state(AgentState::WaitingForAi);
                if let Err(e) = ensure_sent(&mut input, &result_blocks, false, stop.clone()).await {
                    if halted.load(Ordering::SeqCst) {
                        finish(
                            &shared,
                            &app,
                            &mut meta,
                            &input,
                            AgentState::Cancelled,
                            "stopped by user".into(),
                        );
                    } else {
                        finish_error(&shared, &app, &input.task_id, &e);
                    }
                    input.app.state::<ActiveAgent>().clear(&input.task_id);
                    return;
                }
            }
        }
    }
}

/// Submit once and fail clearly. Retrying a provider send after an uncertain
/// acknowledgement can duplicate a prompt, and silently switching to manual
/// relay breaks the single-chat workflow.
async fn ensure_sent(
    input: &mut AgentInput,
    text: &str,
    first_of_task: bool,
    stop: Arc<Notify>,
) -> Result<(), String> {
    let provider_name = input.provider.describe();
    let web_provider = matches!(&input.provider, Provider::Web(_));
    let result = tokio::select! {
        _ = stop.notified() => return Err("stopped by user while waiting for provider".into()),
        result = input.provider.send(&input.task_id, &input.conversation_id, text, first_of_task) => result,
    };
    result.map_err(|error| provider_send_failure(&provider_name, &error.to_string(), web_provider))
}

fn provider_send_failure(provider: &str, error: &str, is_web: bool) -> String {
    if is_web {
        format!("{provider} unavailable: {error}. Neelima did not confirm prompt submission and did not retry it. Open the provider sign-in window and test the connection, or choose a configured Ollama/LM Studio model.")
    } else {
        format!("{provider} request failed: {error}. The task ended and can be retried.")
    }
}

struct AgentLifecycleGuard {
    app: tauri::AppHandle,
    task_id: String,
    shared: Arc<AgentShared>,
    history: Arc<HistoryStore>,
    state: Arc<crate::webprov::WebviewState>,
}

impl AgentLifecycleGuard {
    fn start(
        app: tauri::AppHandle,
        task_id: String,
        shared: Arc<AgentShared>,
        history: Arc<HistoryStore>,
        state: Arc<crate::webprov::WebviewState>,
    ) -> Self {
        *state.task_active.lock().unwrap() = true;
        // A running task uses the provider page in the background. Make sure its
        // browser pane is not left on screen over Neelima's own conversation.
        crate::webprov::hide_if_any(&app, &state);
        Self {
            app,
            task_id,
            shared,
            history,
            state,
        }
    }
}

impl Drop for AgentLifecycleGuard {
    fn drop(&mut self) {
        if !matches!(
            self.shared.current_state(),
            AgentState::Done | AgentState::Error | AgentState::Cancelled
        ) {
            finish_error(
                &self.shared,
                &self.app,
                &self.task_id,
                "Task stopped unexpectedly. You can retry it from Neelima chat.",
            );
        }
        let _ = self.history.fail_if_running(&self.task_id);
        // Phase A: after the guard drops, nothing can progress this task's
        // open ledger records anymore — close them truthfully (executing ones
        // become UnknownOutcome, earlier ones NotExecuted).
        if let Some(ledger) = crate::action::ledger_of(&self.app) {
            let _ = ledger.fail_open_for_task(&self.task_id);
        }
        // Clear the webview task flag before releasing the active-task slot.
        // A new task can only start after `clear`, so the old guard cannot
        // overwrite the new task's flag afterward.
        *self.state.task_active.lock().unwrap() = false;
        if let Some(active) = self.app.try_state::<ActiveAgent>() {
            active.clear(&self.task_id);
        }
        crate::webprov::destroy_if_idle(&self.app, &self.state, false);
    }
}

// ---- Phase 3O: completion-summary verification ---------------------------

/// How a DONE-summary sentence/clause uses a mentioned path (Phase 3O
/// Checkpoint 4). Only `WriteClaim` counts as a claim of a completed file
/// operation — the kind the execution ledger can verify or falsify.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClaimKind {
    /// The clause asserts a completed file operation ("created", "updated", …).
    WriteClaim,
    /// The clause explicitly says the file was NOT changed ("was not modified").
    NotModified,
    /// The clause describes intended future changes ("will update").
    FutureIntent,
    /// Anything else — a mere mention without asserting a write.
    Reference,
}

/// Byte ranges of sentences: split only at terminal punctuation (.!?) that is
/// followed by whitespace or the end of text. A '.' inside a path (src/lib.rs),
/// a version (1.2) or an abbreviation (e.g.VERS) is not followed by whitespace,
/// so real path tokens survive the split.
fn sentence_ranges(text: &str) -> Vec<(usize, usize)> {
    let b = text.as_bytes();
    let mut ranges = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < b.len() {
        if b[i] != b'.' && b[i] != b'!' && b[i] != b'?' {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < b.len() && (b[j] == b'.' || b[j] == b'!' || b[j] == b'?') {
            j += 1;
        }
        if j == b.len() || b[j] == b' ' || b[j] == b'\n' || b[j] == b'\r' || b[j] == b'\t' {
            ranges.push((start, j));
            while j < b.len() && (b[j] as char).is_ascii_whitespace() {
                j += 1;
            }
            start = j;
            i = j;
        } else {
            i = j;
        }
    }
    if start < b.len() {
        ranges.push((start, b.len()));
    }
    ranges
}

/// Negated file-operation verbs: "did not modify", "was not created",
/// "never wrote", "not be updated", "left… unchanged".
fn is_negated_change(clause: &str) -> bool {
    let notverb = regex::Regex::new(
        r"(?i)\b(?:not|never)\s+(?:been\s+|be\s+|been\s+)?[a-z]*?(creat|writ|updat|modif|chang|edit|delet|remov|overwrit|touch|generat|renam)",
    )
    .unwrap();
    let nochanges = regex::Regex::new(
        r"(?i)\b(?:unchanged|untouched|left(?: as| unchanged| untouched)|no (?:changes|modifications|edits|writes|operations))",
    )
    .unwrap();
    let without_ing = regex::Regex::new(
        r"(?i)\bwithout\s+[a-z]*?(creat|writ|updat|modif|chang|edit|delet|touch)ing",
    )
    .unwrap();
    notverb.is_match(clause) || nochanges.is_match(clause) || without_ing.is_match(clause)
}

fn is_completed_change(clause: &str) -> bool {
    regex::Regex::new(
        r"(?i)\b(created|constructed|generated|updated|wrote|written|modified|rewrote|deleted|removed|edited|changed|replaced|overwrote|added|applied|implemented|renamed|refactored|moved)\b",
    )
    .unwrap()
    .is_match(clause)
}

fn is_future_intent(clause: &str) -> bool {
    regex::Regex::new(
        r"(?i)\b(will(?:\s+(?:be|not))?|shall|going\s+to|plans?\s+to|planning\s+to|about\s+to|intend(?:s|ed)?\s+to|needs?\s+to|should(?:\s+be)?\s+[a-z]*?(creat|writ|updat|modif|chang|edit|delet|remov)|pending|not\s+yet|later)",
    )
    .unwrap()
    .is_match(clause)
}

fn classify_clause(clause: &str) -> ClaimKind {
    // Evaluation order IS the conservatism policy: a clear negation wins; a
    // completed-op verb (even next to a hedge like "pending … execution")
    // stays a claim; only unclaimed mentions fall through to Reference.
    if is_negated_change(clause) {
        ClaimKind::NotModified
    } else if is_completed_change(clause) {
        ClaimKind::WriteClaim
    } else if is_future_intent(clause) {
        ClaimKind::FutureIntent
    } else {
        ClaimKind::Reference
    }
}

/// Same as claimed_paths, but each token carries the way its own clause uses
/// it (see ClaimKind). First occurrence decides; later duplicates keep it.
fn classified_paths(summary: &str) -> Vec<(String, ClaimKind)> {
    let re =
        regex::Regex::new(r"[A-Za-z0-9_][A-Za-z0-9_.-/\\]*[A-Za-z0-9_]\.[A-Za-z][A-Za-z0-9]{1,7}")
            .unwrap();
    let ranges = sentence_ranges(summary);
    let mut out: Vec<(String, ClaimKind)> = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for m in re.find_iter(summary) {
        let tok = m
            .as_str()
            .trim_end_matches(['.', ',', ';', ':', ')', ']', '}']);
        if tok.len() >= 4 && !tok.contains("..") {
            let segments: Vec<&str> = tok.split('.').collect();
            let interior = &segments[..segments.len() - 1];
            if interior.iter().any(|s| s.len() < 2) {
                continue;
            }
            if seen.insert(tok.to_string()) {
                let (s, e) = ranges
                    .iter()
                    .find(|(s, e)| m.start() >= *s && m.start() < *e)
                    .copied()
                    .unwrap_or((0, summary.len()));
                let sentence = &summary[s..e].trim();
                // The token's own clause decides; find it by rescanning the
                // sentence for the token's relative position.
                let rel = sentence.find(tok).unwrap_or(0);
                let kind = split_clauses(sentence)
                    .into_iter()
                    .find(|(start, end)| rel >= *start && rel < *end)
                    .map(|(start, end)| classify_clause(&sentence[start..end]))
                    .unwrap_or_else(|| classify_clause(sentence));
                out.push((tok.to_string(), kind));
            }
        }
    }
    out
}

/// (byte-start, byte-end) clause windows inside one sentence, split at
/// semicolons, em dashes, -- and commas. Over-large regexes avoided on
/// purpose: a plain state machine keeps clause offsets exact.
fn split_clauses(sentence: &str) -> Vec<(usize, usize)> {
    let b = sentence.as_bytes();
    let mut ranges = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < b.len() {
        let is_delim = b[i] == b';' || b[i] == b',' || (b[i] == 0xE2 && i + 2 < b.len());
        let double_dash = b[i] == b'-' && i + 1 < b.len() && b[i + 1] == b'-';
        if !is_delim && !double_dash {
            i += 1;
            continue;
        }
        let mut j = if b[i] == 0xE2 {
            i + 3
        } else if double_dash {
            i + 2
        } else {
            i + 1
        };
        while j < b.len() && (b[j] as char).is_ascii_whitespace() {
            j += 1;
        }
        ranges.push((start, i));
        start = j;
        i = j;
    }
    if start < b.len() {
        ranges.push((start, b.len()));
    }
    ranges
}

/// Path-like tokens mentioned in a DONE summary: basename or workspace-relative
/// path, letter/digit start, real extension (≥2 chars), no traversal dots.
/// Enumerator/abbreviations like "e.g." are excluded by construction.
/// Test-only helper: production code checks the classified variant below.
#[cfg(test)]
fn claimed_paths(summary: &str) -> Vec<String> {
    classified_paths(summary)
        .into_iter()
        .map(|(t, _)| t)
        .collect()
}

/// Does a recorded workspace-relative path satisfy one claimed token?
fn recorded_matches_claim(recorded: &str, claim: &str) -> bool {
    let norm = |s: &str| s.replace('\\', "/");
    let recorded = norm(recorded);
    let claim = norm(claim);
    if recorded == claim {
        return true;
    }
    let suffix = format!("/{claim}");
    recorded.ends_with(&suffix)
        || recorded
            .rsplit('/')
            .next()
            .is_some_and(|base| base == claim)
}

/// Ground the model's DONE summary in the task's recorded file operations.
/// Returns an append-only note (or None when there is nothing to check).
/// A model statement is never proof of execution: paths with no matching
/// successful write are called out as unverified.
fn summarize_write_claims(
    summary: &str,
    ops: &[(String, String, crate::action::FileOpOutcome)],
) -> Option<String> {
    use crate::action::FileOpOutcome::*;
    // Only an explicit completed-file-operation assertion is a claim the ledger
    // can verify or falsify. Negations ("was not modified"), intended future
    // changes ("will update "), and mere mentions are classification-only and
    // are never reported as missing execution evidence (Checkpoint 4). The
    // conservatism policy lives in classify_clause: a completed-op verb next to
    // a hedge ("... pending workspace tool execution") is still a claim, so
    // false-ledger claims cannot slip through as "intent".
    let claims: Vec<String> = classified_paths(summary)
        .into_iter()
        .filter(|(_, kind)| *kind == ClaimKind::WriteClaim)
        .map(|(token, _)| token)
        .collect();
    let verified: Vec<&String> = ops
        .iter()
        .filter(|(_, _, o)| *o == Succeeded)
        .map(|(_, p, _)| p)
        .collect();
    let failed: Vec<&String> = ops
        .iter()
        .filter(|(_, _, o)| *o == Failed)
        .map(|(_, p, _)| p)
        .collect();

    if ops.is_empty() {
        return if claims.is_empty() {
            None
        } else {
            Some(format!(
                "Execution check: the summary mentions {} path(s) ({}), but no file operations were recorded for this task — these claims are unverified.",
                claims.len(),
                claims.join(", ")
            ))
        };
    }

    let mut verified_claims = Vec::new();
    let mut unverified = Vec::new();
    for c in &claims {
        if verified.iter().any(|p| recorded_matches_claim(p, c)) {
            verified_claims.push(c.clone());
        } else if failed.iter().any(|p| recorded_matches_claim(p, c)) {
            unverified.push(format!("{c} (recorded as failed)"));
        } else {
            unverified.push(c.clone());
        }
    }

    match (verified_claims.as_slice(), unverified.as_slice()) {
        ([], []) => None,
        (_, []) => Some(format!(
            "Execution check: verified against recorded file operations — {}",
            verified_claims.join(", ")
        )),
        ([], _) => Some(format!(
            "Execution check: no successful write recorded for {} — claim(s) unverified.",
            unverified.join(", ")
        )),
        (_, _) => Some(format!(
            "Execution check: verified — {}; unverified (no successful write recorded) — {}.",
            verified_claims.join(", "),
            unverified.join(", ")
        )),
    }
}

fn finish_error(shared: &Arc<AgentShared>, app: &tauri::AppHandle, task_id: &str, msg: &str) {
    if let Some(history) = app.try_state::<Arc<HistoryStore>>() {
        if history.contains_task(task_id) {
            let failure = TranscriptEntry {
                id: history.next_entry_id(),
                ts: history::now_ms(),
                kind: "error".into(),
                text: msg.to_string(),
                calls: Vec::new(),
                diff: None,
                injection_warning: None,
            };
            match history.append_once(task_id, &failure) {
                Ok(true) => emit(
                    app,
                    AgentEvent {
                        kind: "transcript".into(),
                        state: None,
                        task_id: Some(task_id.to_string()),
                        entry: Some(failure),
                        pending_calls: None,
                        text: None,
                    },
                ),
                Ok(false) => {}
                Err(error) => {
                    let _ = app.emit(
                        EVT,
                        json!({"kind":"notify", "level":"error", "text":format!("Could not save task failure: {error}")}),
                    );
                }
            }
        }
    }
    clear_active_task(app, task_id);
    shared.set_state(AgentState::Error);
    let _ = app.emit(
        EVT,
        serde_json::to_value(AgentEvent {
            kind: "agent-state".into(),
            state: Some(AgentState::Error),
            task_id: Some(task_id.into()),
            pending_calls: None,
            text: Some(msg.to_string()),
            entry: None,
        })
        .unwrap_or(Value::Null),
    );
}

fn finish(
    shared: &Arc<AgentShared>,
    app: &tauri::AppHandle,
    meta: &mut history::TaskMeta,
    input: &AgentInput,
    state: AgentState,
    summary: String,
) {
    meta.status = format!("{state:?}").to_lowercase();
    meta.ended_ms = Some(history::now_ms());
    let _ = input.history.update_task(meta);
    clear_active_task(app, &input.task_id);
    shared.set_state(state);
    let _ = app.emit(
        EVT,
        serde_json::to_value(AgentEvent {
            kind: "agent-state".into(),
            state: Some(state),
            task_id: Some(input.task_id.clone()),
            pending_calls: None,
            text: Some(summary),
            entry: None,
        })
        .unwrap_or(Value::Null),
    );
}

fn clear_active_task(app: &tauri::AppHandle, task_id: &str) {
    if let Some(active) = app.try_state::<ActiveAgent>() {
        active.clear(task_id);
    }
}

/// CP6: what the approval preview was computed against. Human-approved
/// write/edit/delete calls are re-checked against this exact snapshot right
/// before the existing tool executor runs, so a file that changed after the
/// preview cannot be silently overwritten by a decision made about older
/// content. This is NOT a second writer or a second approval system: it only
/// refuses, and the existing tools::execute remains the only write path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PreviewBaseline {
    /// The destination did not exist when the preview was shown.
    Absent,
    /// Exact bytes the preview was computed from.
    Content(String),
    /// The exact bytes could not be captured (over the 2 MB diff limit, an
    /// unreadable/binary file, or a metadata error). An approval-gated write
    /// in this state FAILS CLOSED: the preview has no trustworthy baseline, so
    /// it is refused before the tool executor. (FullAccess writes are a
    /// separate authorization mode and are not preview-guarded at all.)
    Unavailable,
}

/// Capture the preview-time baseline for a write/edit/delete call. `None`
/// means the call is not a guardable file mutation or its arguments/path are
/// invalid (the tool's own validation still runs and fails closed).
pub(crate) fn capture_preview_baseline(
    ws: &Workspace,
    call: &ToolCall,
) -> Option<PreviewBaseline> {
    if !matches!(call.tool.as_str(), "write_file" | "edit_file" | "delete_file") {
        return None;
    }
    let path = call.args.get("path").and_then(Value::as_str)?;
    let abs = ws.resolve(path).ok()?;
    match std::fs::metadata(&abs) {
        Ok(meta) if meta.len() > tools::MAX_DIFF_BYTES as u64 => {
            Some(PreviewBaseline::Unavailable)
        }
        // An existing file whose exact bytes cannot be captured is also
        // Unavailable — never Absent, which would let a write proceed as if
        // there were nothing to protect.
        Ok(_) => Some(
            std::fs::read_to_string(&abs)
                .map(PreviewBaseline::Content)
                .unwrap_or(PreviewBaseline::Unavailable),
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Some(PreviewBaseline::Absent)
        }
        Err(_) => Some(PreviewBaseline::Unavailable),
    }
}

/// `Some(CONFLICT::…)` when the destination no longer matches the preview
/// baseline. Never writes, never mutates anything.
pub(crate) fn preview_baseline_conflict(
    ws: &Workspace,
    call: &ToolCall,
    baseline: &PreviewBaseline,
) -> Option<String> {
    let path = call.args.get("path").and_then(Value::as_str)?;
    let abs = ws.resolve(path).ok()?;
    if let PreviewBaseline::Unavailable = baseline {
        return Some(format!(
            "REFUSED::{} is larger than the {}-byte approval-preview limit or its exact contents could not be captured, so the review had no trustworthy baseline. The approved call was NOT executed and nothing was written. Shrink the file or make the change through the editor's review-and-save flow.",
            path,
            tools::MAX_DIFF_BYTES
        ));
    }
    let changed = match baseline {
        PreviewBaseline::Unavailable => unreachable!("handled above"),
        PreviewBaseline::Absent => abs.exists(),
        PreviewBaseline::Content(expected) => {
            std::fs::read_to_string(&abs).map(|now| &now != expected).unwrap_or(true)
        }
    };
    changed.then(|| {
        format!(
            "CONFLICT::{} changed on disk after the approval preview was shown, so this approved call was not executed — applying it would overwrite newer content. Nothing was written; re-read the file and propose the change again.",
            path
        )
    })
}

/// After a successful guarded write in the same approved batch, later calls
/// targeting that path are validated against the batch's own result rather
/// than the pre-batch snapshot: they were all approved together.
pub(crate) fn refresh_preview_baselines(
    ws: &Workspace,
    path: &str,
    baselines: &mut HashMap<String, (String, PreviewBaseline)>,
) {
    let Ok(abs) = ws.resolve(path) else { return };
    let baseline = match std::fs::metadata(&abs) {
        Ok(meta) if meta.len() > tools::MAX_DIFF_BYTES as u64 => PreviewBaseline::Unavailable,
        Ok(_) => match std::fs::read_to_string(&abs) {
            Ok(now) => PreviewBaseline::Content(now),
            Err(_) => PreviewBaseline::Unavailable,
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => PreviewBaseline::Absent,
        Err(_) => PreviewBaseline::Unavailable,
    };
    for (recorded_path, value) in baselines.values_mut() {
        if recorded_path == path {
            *value = baseline.clone();
        }
    }
}

/// CP6: workspace-relative paths a successful file-mutation call touched.
/// `move_file` owns two; every other write tool owns one. Paths are resolved
/// through the same workspace confinement the tool used and rendered in the
/// canonical display form used by the tree, tabs and diffs.
pub(crate) fn changed_paths(ws: &Workspace, call: &ToolCall) -> Vec<String> {
    let keys: &[&str] = match call.tool.as_str() {
        "write_file" | "edit_file" | "delete_file" => &["path"],
        "move_file" => &["from", "to"],
        _ => return Vec::new(),
    };
    keys.iter()
        .filter_map(|key| call.args.get(*key).and_then(Value::as_str))
        .filter_map(|rel| ws.resolve(rel).ok())
        .map(|abs| ws.display(&abs))
        .collect()
}

/// Did this successful mutation actually change bytes? `write_file` returns
/// no diff when it rewrote identical content, and `edit_file` can replace text
/// with itself; neither is a file change worth refreshing the workspace for.
/// An append has no diff but always writes.
pub(crate) fn write_changed_bytes(call: &ToolCall, outcome: &tools::ToolOutcome) -> bool {
    if !outcome.ok {
        return false;
    }
    match call.tool.as_str() {
        "write_file" => {
            let append = call
                .args
                .get("append")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            append || outcome.diff.is_some()
        }
        "edit_file" => outcome
            .diff
            .as_ref()
            .map(|(_, old, new)| old != new)
            .unwrap_or(false),
        "delete_file" | "move_file" => true,
        _ => false,
    }
}

fn preview_diff(ws: &Workspace, call: &ToolCall) -> Option<serde_json::Value> {
    let path = call.args.get("path").and_then(Value::as_str)?;
    match call.tool.as_str() {
        "write_file" | "edit_file" => {
            let abs = ws.resolve(path).ok()?;
            let skipped = || {
                json!({
                    "path": path,
                    "old": "[diff omitted: file exceeds 2 MB]",
                    "new": "[diff omitted: file exceeds 2 MB]"
                })
            };
            let old_len = std::fs::metadata(&abs).map(|m| m.len()).unwrap_or(0);
            if old_len > tools::MAX_DIFF_BYTES as u64 {
                return Some(skipped());
            }
            let old = std::fs::read_to_string(&abs).unwrap_or_default();
            let new = match call.tool.as_str() {
                "write_file" => {
                    let content = call
                        .args
                        .get("content")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if content.len() > tools::MAX_DIFF_BYTES
                        || old.len().saturating_add(content.len()) > tools::MAX_DIFF_BYTES
                    {
                        return Some(skipped());
                    }
                    // Append was reviewed as a full replacement before CP6;
                    // show the real post-write content instead.
                    if call
                        .args
                        .get("append")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                    {
                        format!("{old}{content}")
                    } else {
                        content.to_string()
                    }
                }
                "edit_file" => {
                    let old_s = call.args.get("old_string").and_then(Value::as_str)?;
                    let new_s = call.args.get("new_string").and_then(Value::as_str)?;
                    let all = call
                        .args
                        .get("replace_all")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let replacements = if all {
                        old.matches(old_s).count()
                    } else {
                        usize::from(old.contains(old_s))
                    };
                    let projected_len = old
                        .len()
                        .saturating_sub(replacements.saturating_mul(old_s.len()))
                        .saturating_add(replacements.saturating_mul(new_s.len()));
                    if old.len() > tools::MAX_DIFF_BYTES
                        || new_s.len() > tools::MAX_DIFF_BYTES
                        || projected_len > tools::MAX_DIFF_BYTES
                    {
                        return Some(skipped());
                    }
                    if all {
                        old.replace(old_s, new_s)
                    } else {
                        old.replacen(old_s, new_s, 1)
                    }
                }
                _ => return None,
            };
            if old.len() > tools::MAX_DIFF_BYTES || new.len() > tools::MAX_DIFF_BYTES {
                return Some(skipped());
            }
            Some(json!({"path": path, "old": old, "new": new}))
        }
        // CP6: deletion is a reviewed change too — show the exact content the
        // user is about to remove instead of only the path.
        "delete_file" => {
            let abs = ws.resolve(path).ok()?;
            let meta = std::fs::metadata(&abs).ok()?;
            if meta.len() > tools::MAX_DIFF_BYTES as u64 {
                return Some(json!({
                    "path": path,
                    "old": "[diff omitted: file exceeds 2 MB]",
                    "new": ""
                }));
            }
            let old = std::fs::read_to_string(&abs).ok()?;
            Some(json!({"path": path, "old": old, "new": ""}))
        }
        _ => None,
    }
}

fn tree_summary(ws: &Workspace, depth: usize, max_entries: usize) -> String {
    let mut lines = Vec::new();
    walk(ws.root(), 0, depth, &mut lines, max_entries);
    if lines.is_empty() {
        "(empty workspace)".into()
    } else {
        lines.join("\n")
    }
}

fn walk(
    dir: &std::path::Path,
    level: usize,
    depth: usize,
    lines: &mut Vec<String>,
    max: usize,
) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn shared_for(task_id: &str) -> Arc<AgentShared> {
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        Arc::new(AgentShared {
            cmd_tx,
            cmd_rx: Mutex::new(Some(cmd_rx)),
            state: Mutex::new(AgentState::WaitingForAi),
            task_id: Mutex::new(Some(task_id.to_string())),
        })
    }

    #[test]
    fn stale_task_cleanup_cannot_clear_a_newer_active_task() {
        let slot = ActiveAgent::default();
        *slot.0.lock().unwrap() = Some(shared_for("old-task"));
        slot.clear("old-task");
        *slot.0.lock().unwrap() = Some(shared_for("new-task"));
        slot.clear("old-task");
        assert_eq!(
            slot.get().unwrap().task_id.lock().unwrap().as_deref(),
            Some("new-task")
        );
        slot.clear("new-task");
        assert!(slot.get().is_none());
    }

    #[test]
    fn terminal_task_cleanup_allows_a_follow_up_task() {
        let slot = ActiveAgent::default();
        *slot.0.lock().unwrap() = Some(shared_for("finished"));
        slot.clear("finished");
        assert!(slot.get().is_none());

        *slot.0.lock().unwrap() = Some(shared_for("next-task"));
        assert_eq!(
            slot.get().unwrap().task_id.lock().unwrap().as_deref(),
            Some("next-task")
        );
        slot.clear("next-task");
    }

    #[test]
    fn permission_modes_gate_tools_and_destructive_commands() {
        use crate::settings::PermissionMode;
        let guard = CommandGuard::new(&[], &[]).unwrap();
        let args = json!({});
        assert!(tool_needs_approval(
            "read_file",
            &args,
            PermissionMode::AskAll,
            &guard
        ));
        assert!(!tool_needs_approval(
            "read_file",
            &args,
            PermissionMode::AskWrites,
            &guard
        ));
        assert!(tool_needs_approval(
            "write_file",
            &args,
            PermissionMode::AskWrites,
            &guard
        ));
        assert!(!tool_needs_approval(
            "write_file",
            &args,
            PermissionMode::FullAccess,
            &guard
        ));
        assert!(!tool_needs_approval(
            "run_command",
            &json!({"command":"git status"}),
            PermissionMode::FullAccess,
            &guard
        ));
        assert!(tool_needs_approval(
            "run_command",
            &json!({"command":"git reset --hard HEAD"}),
            PermissionMode::FullAccess,
            &guard
        ));
    }

    #[test]
    fn provider_cannot_report_unavailable_tools_as_successful_completion() {
        assert!(completion_reports_unavailable_tools(
            "Unable to create the app because workspace tools are not available in this session"
        ));
        assert!(!completion_reports_unavailable_tools(
            "Created the app and verified the files"
        ));
        assert!(!completion_reports_unavailable_tools(
            "The tool output says no files were found"
        ));
    }

    #[test]
    fn provider_submission_failure_is_truthful_and_actionable() {
        let failure = provider_send_failure("web:ChatGPT", "composer not found", true);
        assert!(failure.contains("did not confirm prompt submission"));
        assert!(failure.contains("Ollama/LM Studio"));
        assert!(!failure.contains("switched to manual relay"));

        let local = provider_send_failure("local:Ollama", "connection refused", false);
        assert!(local.contains("task ended"));
        assert!(!local.contains("sign-in window"));
    }

    /// Early-approval race: a decision delivered while the loop is still in
    /// WaitingForAi is buffered and applied to the next approval wait instead
    /// of being silently dropped (which would deadlock until Stop).
    #[test]
    fn early_approval_decisions_are_buffered_not_dropped() {
        // (Behavior probe of the same channel plumbing the loop uses.)
        let (approve_tx, mut approve_rx) = mpsc::unbounded_channel::<Vec<CallDecision>>();
        approve_tx
            .send(vec![CallDecision {
                id: "1".into(),
                approved: true,
            }])
            .unwrap();
        // Replaying the loop's select arms: the recv returns the early decision.
        let got = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(approve_rx.recv())
            .unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, "1");
        assert!(got[0].approved);
    }

    /// Phase A: the approval gate's risk strings and the ledger's risk
    /// mapping must never drift — the ledger records what the gate used.
    #[test]
    fn call_risk_agrees_with_action_risk_mapping() {
        for (tool, _) in tools::tool_names() {
            let expected = match crate::action::risk_of_tool(tool) {
                crate::action::Risk::Read => "read",
                crate::action::Risk::Write => "write",
                crate::action::Risk::Command => "command",
                crate::action::Risk::Other => "other",
            };
            assert_eq!(call_risk(tool), expected, "risk drift for {tool}");
        }
    }

    #[test]
    fn preview_diff_skips_large_existing_files() {
        let root = std::env::temp_dir().join(format!("neelima-preview-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("large.txt");
        std::fs::write(&path, vec![b'x'; tools::MAX_DIFF_BYTES + 1]).unwrap();
        let ws = Workspace::open(&root).unwrap();
        let call = ToolCall {
            id: "1".into(),
            tool: "write_file".into(),
            args: json!({"path":"large.txt","content":"replacement"}),
            security_nonce: None,
        };

        let preview = preview_diff(&ws, &call).unwrap();
        assert_eq!(preview["old"], "[diff omitted: file exceeds 2 MB]");
        assert_eq!(preview["new"], "[diff omitted: file exceeds 2 MB]");

        std::fs::remove_dir_all(root).unwrap();
    }

    /// Phase 4: the approval gate is the trust boundary for model output.
    /// Every tool class x permission mode combination is asserted explicitly so
    /// a future edit cannot quietly widen one of them.
    #[test]
    fn approval_matrix_covers_every_tool_class_and_permission_mode() {
        use crate::sec::CommandGuard;
        use crate::settings::PermissionMode::{AskAll, AskWrites, FullAccess};
        let guard = CommandGuard::new(&[], &[]).unwrap();
        let read = json!({"path": "src/main.rs"});
        let write = json!({"path": "new.txt", "content": "x"});
        let benign_cmd = json!({"command": "cargo test"});

        let needs = |tool: &str, args: &Value, mode| tool_needs_approval(tool, args, mode, &guard);

        // Reads: only AskAll asks.
        for mode in [AskAll, AskWrites, FullAccess] {
            assert_eq!(
                needs("read_file", &read, mode),
                mode == AskAll,
                "{mode:?} read"
            );
        }
        // Writes: AskAll and AskWrites ask; FullAccess does not.
        for mode in [AskAll, AskWrites, FullAccess] {
            assert_eq!(
                needs("write_file", &write, mode),
                mode != FullAccess,
                "{mode:?} write"
            );
        }
        // Commands follow the same rule as writes...
        for mode in [AskAll, AskWrites, FullAccess] {
            assert_eq!(
                needs("run_command", &benign_cmd, mode),
                mode != FullAccess,
                "{mode:?} command"
            );
        }
        // ...UNLESS the command matches an always-ask pattern, which forces the
        // dialog even in FullAccess.
        let destructive = json!({"command": "rm -rf ~"});
        for mode in [AskAll, AskWrites, FullAccess] {
            assert!(
                needs("run_command", &destructive, mode),
                "{mode:?} rm -rf ~"
            );
        }
        // A missing/empty command is not an auto-approve: it is still subject to
        // the mode (and the runner refuses it separately).
        let empty = json!({});
        assert!(needs("run_command", &empty, AskAll));
        assert!(needs("run_command", &empty, AskWrites));

        // Unknown tools are never auto-approved outside FullAccess, and even
        // there the dispatcher refuses them (tools::execute has no arm for them).
        let unknown = json!({"anything": true});
        for mode in [AskAll, AskWrites] {
            assert!(needs("exec_everything", &unknown, mode), "{mode:?} unknown");
        }
        let outcome = crate::tools::execute(
            &Workspace::open(&std::env::temp_dir()).unwrap(),
            &ToolCall {
                id: "u".into(),
                tool: "exec_everything".into(),
                args: unknown,
                security_nonce: None,
            },
            &Settings::default(),
        );
        assert!(
            !outcome.ok,
            "an unknown tool must never run: {:?}",
            outcome.output
        );
        assert!(
            outcome.output.contains("unknown tool"),
            "{}",
            outcome.output
        );
    }

    // ---- Phase 3O: completion-summary verification ---------------------------

    use crate::action::FileOpOutcome as FOO;

    fn ops(entries: &[(&str, &str, FOO)]) -> Vec<(String, String, FOO)> {
        entries
            .iter()
            .map(|(t, p, o)| ((*t).to_string(), (*p).to_string(), *o))
            .collect()
    }

    #[test]
    fn claims_extract_paths_but_not_prose() {
        let got = claimed_paths(
            "Created main.py, updated src/lib.rs and README.md. e.g.VERS 1.2 costs 50%. Done.",
        );
        assert!(got.contains(&"main.py".to_string()));
        assert!(got.contains(&"src/lib.rs".to_string()));
        assert!(got.contains(&"README.md".to_string()));
        // "1.2" is a number, "VERS 1.2" hits the extractor but the trim and
        // the digit-start rule keep e.g./etc. out.
        assert!(!got.iter().any(|t| t.ends_with(".2") && t.len() < 5));
        assert!(claimed_paths("Nothing here.").is_empty());
    }

    #[test]
    fn recorded_paths_match_suffix_and_basename_claims() {
        assert!(recorded_matches_claim("src/main.py", "main.py"));
        assert!(recorded_matches_claim("src/main.py", "src/main.py"));
        assert!(recorded_matches_claim("docs\\readme.md", "docs/readme.md"));
        assert!(!recorded_matches_claim("src/main.py", "lib.py"));
        assert!(!recorded_matches_claim("src/main.py", "src/other/main.py"));
    }

    #[test]
    fn false_file_claims_are_reported_unverified() {
        // The Phase 3N real-world failure: the agent claimed README.md but no
        // successful write exists in the ledger.
        let note = summarize_write_claims(
            "DONE: Created main.py and README.md.",
            &ops(&[("write_file", "main.py", FOO::Succeeded)]),
        )
        .expect("note emitted");
        assert!(
            note.contains("README.md"),
            "names the unverified file: {note}"
        );
        assert!(note.contains("unverified"));
    }

    #[test]
    fn failed_writes_are_reported_as_failed_not_verified() {
        let note = summarize_write_claims(
            "DONE: Wrote output.csv and chart.png.",
            &ops(&[
                ("write_file", "output.csv", FOO::Succeeded),
                ("write_file", "chart.png", FOO::Failed),
            ]),
        )
        .unwrap();
        assert!(note.contains("verified"));
        assert!(note.contains("chart.png (recorded as failed)"), "{note}");
        assert!(note.contains("output.csv"));
    }

    #[test]
    fn cancelled_and_stale_task_records_never_verify_a_claim() {
        // Cancelled batch for claimed files, plus a write belonging to a
        // DIFFERENT task path: neither verifies anything.
        let note = summarize_write_claims(
            "DONE: Wrote alpha.py and beta.py.",
            &ops(&[
                ("write_file", "alpha.py", FOO::Failed),
                ("write_file", "beta.py", FOO::Unknown),
            ]),
        )
        .unwrap();
        assert!(note.contains("alpha.py (recorded as failed)"), "{note}");
        assert!(note.contains("unverified"));
        // b.py stayed in flight: it is not claimed as verified either.
        assert!(!note.contains("verified —"), "{note}");
    }

    #[test]
    fn claims_without_any_recorded_ops_are_flagged() {
        let note = summarize_write_claims("DONE: Created notes.txt.", &ops(&[]))
            .expect("claim with no ledger entries must be flagged");
        assert!(note.contains("notes.txt"));
        assert!(note.contains("no file operations were recorded"));
    }

    #[test]
    fn nothing_to_check_emits_nothing() {
        assert!(summarize_write_claims("DONE: all good.", &ops(&[])).is_none());
        // Writes happened but the summary names no paths: no verdict to bias.
        assert!(summarize_write_claims(
            "DONE: Finished.",
            &ops(&[("write_file", "main.py", FOO::Succeeded)])
        )
        .is_none());
    }

    #[test]
    fn fully_verified_summary_state_matches() {
        let note = summarize_write_claims(
            "DONE: Created main.py and test_main.py.",
            &ops(&[
                ("write_file", "main.py", FOO::Succeeded),
                ("write_file", "test_main.py", FOO::Succeeded),
            ]),
        )
        .unwrap();
        assert!(note.contains("verified"));
        assert!(!note.contains("unverified"), "{note}");
    }

    // ---- Checkpoint 4: claim classification ---------------------------------

    #[test]
    fn explicit_completed_claim_without_write_is_unverified() {
        // Category 1: "I updated README.md" with no recorded write is a claim
        // of a completed operation and must stay flagged.
        let note = summarize_write_claims("DONE: I updated README.md.", &ops(&[]))
            .expect("completed claim with no ops must be flagged");
        assert!(note.contains("README.md"), "{note}");
        assert!(note.contains("unverified"), "{note}");
    }

    #[test]
    fn not_modified_statement_is_never_flagged_unverified() {
        // Category 2a: mixed summary — a real verified write plus a truthful
        // negative statement. The negation must not appear in the verdict.
        let note = summarize_write_claims(
            "DONE: Successfully created actual_file.txt. README.md was not modified.",
            &ops(&[("write_file", "actual_file.txt", FOO::Succeeded)]),
        )
        .unwrap();
        assert!(note.contains("actual_file.txt"), "{note}");
        assert!(note.contains("verified"), "{note}");
        assert!(!note.contains("unverified"), "{note}");
        assert!(!note.contains("README"), "{note}");
        // 2b: only a negation, no ops — nothing to verify, no warning.
        assert!(
            summarize_write_claims("DONE: I did not modify README.md.", &ops(&[])).is_none(),
            "a truthful not-modified statement must not be called unverified"
        );
    }

    #[test]
    fn future_intent_is_not_reported_as_missing_execution() {
        // Category 3: intended future changes are not completed-op claims.
        let note = summarize_write_claims(
            "DONE: Wrote main.py. I will update README.md later.",
            &ops(&[("write_file", "main.py", FOO::Succeeded)]),
        )
        .unwrap();
        assert!(note.contains("main.py"), "{note}");
        assert!(!note.contains("README"), "{note}");
        assert!(!note.contains("unverified"), "{note}");
        // And on its own, still no missing-evidence report.
        assert!(
            summarize_write_claims("DONE: I will update README.md next.", &ops(&[])).is_none(),
            "future intent must not be called unverified"
        );
    }

    #[test]
    fn mere_reference_is_not_flagged_as_claim() {
        // Category 4: reference without asserting a write.
        assert!(
            summarize_write_claims(
                "DONE: The build passed. README.md contains the project instructions.",
                &ops(&[])
            )
            .is_none(),
            "a mere mention must not be called unverified"
        );
        let note = summarize_write_claims(
            "DONE: Wrote main.py. README.md contains the project instructions.",
            &ops(&[("write_file", "main.py", FOO::Succeeded)]),
        )
        .unwrap();
        assert!(note.contains("main.py"), "{note}");
        assert!(!note.contains("README"), "{note}");
    }

    #[test]
    fn completed_verb_with_hedge_stays_conservative() {
        // Locks the live Phase 3O behavior: "Created X … pending workspace tool
        // execution" is a completed-op claim regardless of the hedge, so a
        // false-ledger claim cannot be camouflaged as intent.
        let note = summarize_write_claims(
            "DONE: Created actual_file.txt with the requested content pending workspace tool execution.",
            &ops(&[]),
        )
        .expect("completed claim beats the pending hedge");
        assert!(note.contains("actual_file.txt"), "{note}");
        assert!(note.contains("unverified"), "{note}");
    }

    #[test]
    fn clause_scoping_keeps_neighbouring_claims_independent() {
        // The negation clause must not swallow the creation clause about the
        // same sentence pair, and vice versa.
        let note = summarize_write_claims("DONE: I created README.md — not deleted it.", &ops(&[]))
            .expect("creation clause is still a claim");
        assert!(note.contains("README.md"), "{note}");
        assert!(note.contains("unverified"), "{note}");
    }

    #[test]
    fn sentence_ranges_keep_paths_and_versions_whole() {
        let text = "Created src/lib.rs for version 1.2. I will update README.md later.";
        let ranges = sentence_ranges(text);
        assert_eq!(ranges.len(), 2, "path/version dots are not sentence ends");
        let first = &text[ranges[0].0..ranges[0].1];
        assert!(first.contains("src/lib.rs"), "{first}");
        assert!(!first.contains("README"), "{first}");
    }

    #[test]
    fn classification_order_is_negation_then_claim_then_intent() {
        assert_eq!(
            classify_clause("README.md was not modified"),
            ClaimKind::NotModified
        );
        assert_eq!(
            classify_clause("Successfully created actual_file.txt pending verification"),
            ClaimKind::WriteClaim
        );
        assert_eq!(
            classify_clause("I will update README.md later"),
            ClaimKind::FutureIntent
        );
        assert_eq!(
            classify_clause("README.md contains the project instructions"),
            ClaimKind::Reference
        );
    }

    // ---- Checkpoint 5: additional classifier cases ---------------------------

    #[test]
    fn has_been_created_is_a_completed_claim() {
        // Passive phrasing still asserts a completed operation: flagged when no
        // write was recorded.
        let note = summarize_write_claims("DONE: README.md has been created.", &ops(&[]))
            .expect("passive completed claim with no ops must be flagged");
        assert!(note.contains("README.md"), "{note}");
        assert!(note.contains("unverified"), "{note}");
    }

    #[test]
    fn was_never_created_is_not_claimed_execution() {
        assert!(
            summarize_write_claims("DONE: README.md was never created.", &ops(&[])).is_none(),
            "a truthful never-created statement must not be called unverified"
        );
    }

    #[test]
    fn attempted_update_without_a_success_claim_is_not_flagged() {
        // "Attempted" reports an attempt, not a completed write; the classifier
        // verifies claims of completion, not effort. No success assertion means
        // there is nothing the ledger can falsify.
        assert!(
            summarize_write_claims("DONE: I attempted to update README.md.", &ops(&[])).is_none(),
            "an attempted update must not be called unverified"
        );
    }

    #[test]
    fn still_needs_updating_is_not_a_completed_claim() {
        assert!(
            summarize_write_claims("DONE: README.md still needs updating.", &ops(&[])).is_none(),
            "an outstanding-changes statement must not be called unverified"
        );
    }

    #[test]
    fn updated_but_write_failed_names_the_recorded_failure() {
        let note = summarize_write_claims(
            "DONE: README.md was updated, but the write failed.",
            &ops(&[("write_file", "README.md", FOO::Failed)]),
        )
        .expect("a completed claim with a recorded failure must surface");
        assert!(note.contains("README.md"), "{note}");
        assert!(note.contains("recorded as failed"), "{note}");
        assert!(note.contains("unverified"), "{note}");
        // And with no ledger entries at all, the claim is still unverified.
        let bare = summarize_write_claims(
            "DONE: README.md was updated, but the write failed.",
            &ops(&[]),
        )
        .expect("claim with no ops must be flagged");
        assert!(bare.contains("unverified"), "{bare}");
    }

    #[test]
    fn multiple_claims_in_one_paragraph_are_categorized_independently() {
        let note = summarize_write_claims(
            "DONE: I updated src/main.py and created src/lib.rs. TODO.txt was never modified.",
            &ops(&[("write_file", "src/main.py", FOO::Succeeded)]),
        )
        .expect("mixed paragraph must produce a verdict");
        assert!(note.contains("src/main.py"), "{note}");
        assert!(note.contains("unverified"), "{note}");
        // lib.rs has no recorded write: named as unverified.
        assert!(note.contains("src/lib.rs"), "{note}");
        // TODO.txt was correctly identified as a negation, never as a claim.
        assert!(!note.contains("TODO"), "{note}");
    }

    // ---- CP6: approved agent changes and stale baselines ------------------

    fn temp_workspace(label: &str) -> (Workspace, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "neelima-cp6-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        (Workspace::open(&root).unwrap(), root)
    }

    fn write_call(id: &str, path: &str, content: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            tool: "write_file".into(),
            args: json!({"path": path, "content": content}),
            security_nonce: None,
        }
    }

    fn edit_call(id: &str, path: &str, old: &str, new: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            tool: "edit_file".into(),
            args: json!({"path": path, "old_string": old, "new_string": new}),
            security_nonce: None,
        }
    }

    /// The exact race CP6 closes: the user reviews a diff, the file changes
    /// externally, then the approved call runs. The guard must refuse with a
    /// CONFLICT marker and leave the newer content untouched — the existing
    /// tool executor is never reached.
    #[test]
    fn approved_edit_with_stale_baseline_is_refused_without_writing() {
        let (ws, root) = temp_workspace("stale");
        std::fs::write(root.join("a.txt"), "v1\n").unwrap();
        let call = edit_call("1", "a.txt", "v1", "v2");

        let baseline = capture_preview_baseline(&ws, &call).unwrap();
        assert_eq!(baseline, PreviewBaseline::Content("v1\n".into()));

        // Another editor/agent writes after the approval preview was shown.
        std::fs::write(root.join("a.txt"), "external\n").unwrap();
        let conflict = preview_baseline_conflict(&ws, &call, &baseline)
            .expect("a changed destination must conflict");
        assert!(conflict.starts_with("CONFLICT::"), "{conflict}");
        assert!(conflict.contains("nothing was written") || conflict.contains("Nothing was written"));
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "external\n",
            "the newer content must never be overwritten"
        );
        std::fs::remove_dir_all(root).ok();
    }

    /// Proposal → approval → execution through the EXISTING tool path, with
    /// the tool's own on-disk verification, and an unchanged baseline.
    #[test]
    fn approved_edit_writes_through_existing_tool_path_and_verifies_disk() {
        let (ws, root) = temp_workspace("apply");
        std::fs::write(root.join("a.txt"), "hello world\n").unwrap();
        let call = edit_call("1", "a.txt", "world", "there");

        let baseline = capture_preview_baseline(&ws, &call).unwrap();
        assert!(
            preview_baseline_conflict(&ws, &call, &baseline).is_none(),
            "unchanged baseline must be allowed"
        );
        let out = tools::execute(&ws, &call, &Settings::default());
        assert!(out.ok, "{}", out.output);
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "hello there\n"
        );
        let (path, old, new) = out.diff.expect("a successful edit carries its diff");
        assert_eq!(path, "a.txt");
        assert_eq!(old, "hello world\n");
        assert_eq!(new, "hello there\n");

        // Rejection never runs the tool: the file stays byte-identical.
        std::fs::write(root.join("a.txt"), "untouched\n").unwrap();
        // (the loop's `!approved` branch does not call tools::execute)
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "untouched\n"
        );
        std::fs::remove_dir_all(root).ok();
    }

    /// Absent → created is a conflict; a same-batch second call sees the
    /// batch's own result (both were approved together).
    #[test]
    fn absent_baselines_and_same_batch_updates_are_handled() {
        let (ws, root) = temp_workspace("batch");
        let first = write_call("1", "new.txt", "one");
        let second = write_call("2", "new.txt", "two");
        let baseline = capture_preview_baseline(&ws, &first).unwrap();
        assert_eq!(baseline, PreviewBaseline::Absent);
        assert!(preview_baseline_conflict(&ws, &first, &baseline).is_none());

        let mut baselines = HashMap::from([
            ("1".to_string(), ("new.txt".to_string(), baseline)),
            (
                "2".to_string(),
                (
                    "new.txt".to_string(),
                    capture_preview_baseline(&ws, &second).unwrap(),
                ),
            ),
        ]);
        // Creating the file externally between preview and execution conflicts.
        std::fs::write(root.join("new.txt"), "external").unwrap();
        assert!(preview_baseline_conflict(&ws, &first, &baselines["1"].1).is_some());

        // After the batch's own successful write, the recorded baseline moves
        // forward so the second approved call is not falsely refused.
        std::fs::write(root.join("new.txt"), "one").unwrap();
        refresh_preview_baselines(&ws, "new.txt", &mut baselines);
        assert!(
            preview_baseline_conflict(&ws, &second, &baselines["2"].1).is_none(),
            "the second call in the same approved batch must see the batch result"
        );
        std::fs::remove_dir_all(root).ok();
    }

    /// CP6 closeout: an approval preview with no capturable baseline (here a
    /// >2 MB file) must fail closed — never become silent permission to
    /// overwrite. The refusal is explicit and no bytes change.
    #[test]
    fn unavailable_baselines_fail_closed_instead_of_overwriting() {
        let (ws, root) = temp_workspace("unavailable");
        let original = "a".repeat(tools::MAX_DIFF_BYTES + 1);
        std::fs::write(root.join("big.txt"), &original).unwrap();
        let call = edit_call("1", "big.txt", "a", "b");

        let baseline = capture_preview_baseline(&ws, &call).unwrap();
        assert_eq!(baseline, PreviewBaseline::Unavailable);
        let refusal = preview_baseline_conflict(&ws, &call, &baseline)
            .expect("an unavailable baseline must be refused, not allowed");
        assert!(refusal.starts_with("REFUSED::"), "{refusal}");
        assert!(refusal.contains("NOT executed"), "{refusal}");
        assert!(refusal.contains("nothing was written"), "{refusal}");
        assert_eq!(
            std::fs::read_to_string(root.join("big.txt")).unwrap(),
            original,
            "the refusal must not modify a single byte"
        );

        // An existing file whose bytes cannot be read is unavailable too, not
        // absent (which would have allowed a blind overwrite).
        let binary = root.join("binary.dat");
        std::fs::write(&binary, [0xff, 0xfe, 0x00, 0x01]).unwrap();
        let binary_call = edit_call("2", "binary.dat", "x", "y");
        assert_eq!(
            capture_preview_baseline(&ws, &binary_call),
            Some(PreviewBaseline::Unavailable),
            "unreadable bytes are never treated as nonexistent"
        );
        assert!(preview_baseline_conflict(
            &ws,
            &binary_call,
            &PreviewBaseline::Unavailable
        )
        .is_some());
        std::fs::remove_dir_all(root).ok();
    }

    /// Deletion is reviewed with the content being removed, not just a path.
    #[test]
    fn preview_diff_shows_deleted_content() {
        let (ws, root) = temp_workspace("delete-preview");
        std::fs::write(root.join("gone.txt"), "line one\nline two\n").unwrap();
        let call = ToolCall {
            id: "1".into(),
            tool: "delete_file".into(),
            args: json!({"path": "gone.txt"}),
            security_nonce: None,
        };
        let preview = preview_diff(&ws, &call).expect("deletion has a preview");
        assert_eq!(preview["path"], "gone.txt");
        assert_eq!(preview["old"], "line one\nline two\n");
        assert_eq!(preview["new"], "");
        // Capturing the baseline is what the approval guard uses for delete.
        assert_eq!(
            capture_preview_baseline(&ws, &call),
            Some(PreviewBaseline::Content("line one\nline two\n".into()))
        );
        std::fs::remove_dir_all(root).ok();
    }

    /// CP6: the UI is refreshed only for real, successful byte changes, and
    /// each event names the canonical workspace-relative path(s).
    #[test]
    fn file_changed_events_cover_exactly_the_mutated_paths() {
        let (ws, root) = temp_workspace("changed-paths");
        std::fs::write(root.join("a.txt"), "one\n").unwrap();

        let edit = edit_call("1", "./a.txt", "one", "one");
        assert_eq!(changed_paths(&ws, &edit), vec!["a.txt"]);
        let out = tools::execute(&ws, &edit, &Settings::default());
        assert!(out.ok, "{}", out.output);
        assert!(
            !write_changed_bytes(&edit, &out),
            "replacing text with itself is not a change"
        );

        let noop = write_call("2", "a.txt", "one\n");
        let out = tools::execute(&ws, &noop, &Settings::default());
        assert!(out.ok, "{}", out.output);
        assert!(!write_changed_bytes(&noop, &out), "identical rewrite");

        let append = ToolCall {
            id: "3".into(),
            tool: "write_file".into(),
            args: json!({"path": "a.txt", "content": "two\n", "append": true}),
            security_nonce: None,
        };
        let out = tools::execute(&ws, &append, &Settings::default());
        assert!(out.ok, "{}", out.output);
        assert!(
            write_changed_bytes(&append, &out),
            "an append has no diff but always writes"
        );
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "one\ntwo\n");

        let mv = ToolCall {
            id: "4".into(),
            tool: "move_file".into(),
            args: json!({"from": "a.txt", "to": "nested/b.txt"}),
            security_nonce: None,
        };
        assert_eq!(changed_paths(&ws, &mv), vec!["a.txt", "nested/b.txt"]);
        let out = tools::execute(&ws, &mv, &Settings::default());
        assert!(out.ok, "{}", out.output);
        assert!(write_changed_bytes(&mv, &out), "a move changes both paths");

        let read = ToolCall {
            id: "5".into(),
            tool: "read_file".into(),
            args: json!({"path": "nested/b.txt"}),
            security_nonce: None,
        };
        assert!(changed_paths(&ws, &read).is_empty(), "reads change nothing");
        assert!(!write_changed_bytes(&read, &tools::execute(&ws, &read, &Settings::default())));

        let escape = write_call("6", "../outside.txt", "x");
        assert!(
            changed_paths(&ws, &escape).is_empty(),
            "paths outside the workspace are never advertised"
        );
        std::fs::remove_dir_all(root).ok();
    }
}
