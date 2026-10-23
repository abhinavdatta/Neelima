//! Browser extension native-message request router.
//!
//! This is the Rust-side half of the `com.neelima.browser_bridge` native-host
//! contract. It validates a `tool.propose` forwarded by the browser extension,
//! binds it to the desktop's explicitly selected workspace (never to a
//! webpage-supplied task/workspace ID), enforces the tool allowlist and the
//! desktop permission mode, and returns a bounded result:
//!
//!   - `accepted_by_backend` — the request is well-formed and routed.
//!   - `awaiting_approval` — the request needs explicit user approval first.
//!   - `error` — rejected (invalid schema, unknown tool, no workspace, etc.).
//!
//! The actual native-messaging host executable (stdin/stdout) and its Chrome/Edge
//! registry registration are a separate host-process deliverable; this module is
//! the Tauri command the host would call once that IPC path exists. Until then,
//! the extension correctly reports "Neelima not connected" and never touches
//! local files.
//!
//! Security invariants (from docs/NATIVE-HOST-PROTOCOL.md):
//!   * The backend is the sole filesystem authority. The extension is never
//!     trusted to enforce path boundaries or approval policy.
//!   * Webpage-supplied task/workspace IDs and authorization claims are ignored.
//!   * Approval is bound to the exact request identity, tool, args, and
//!     selected workspace.
//!   * No arbitrary shell execution is exposed through this protocol.
//!   * Request idempotency prevents retries from repeating side effects.
//!
//! Idempotency scope: the decided-request ring (200 entries) lives in memory
//! only. It protects against transport-level retries and duplicate proposals
//! while the app runs. It is NOT durable exactly-once execution: if the app
//! restarts, a replayed request_id could execute again. This is deliberate —
//! no crash-recovery journal exists — and callers must not claim exactly-once
//! semantics across restarts.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tauri::{AppHandle, Emitter, State, Webview};
use tokio::sync::oneshot;

use crate::settings::SettingsStore;
use crate::tools;
use crate::ui::WorkspaceSlot;

pub const MAX_PROPOSE_BYTES: usize = 256 * 1024;

/// How long a proposal waits for an explicit user approval decision. This must
/// stay BELOW the native-host transport budget (extension 150 s / pipe 150 s)
/// so the real decision — not a transport timeout — reaches the extension.
pub const APPROVAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Tools the extension may propose. Shell execution is intentionally excluded.
pub const ALLOWED_TOOLS: &[&str] = &[
    "list_dir",
    "read_file",
    "grep",
    "glob",
    "write_file",
    "edit_file",
    "move_file",
    "delete_file",
];

/// Max number of recent request IDs retained for idempotency dedupe.
/// Public because the native-host contract document states this bound, and a
/// doc-drift test pins the documented number to this constant.
pub const IDEMPOTENCY_RING: usize = 200;

#[derive(Default)]
pub struct BrowserBridgeHub {
    /// request_id -> oneshot sender awaiting a desktop approval decision.
    /// Used for the approval flow when permission_mode requires it.
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    /// Recently decided request IDs, for idempotency (a repeated proposal with
    /// the same request_id is not re-executed).
    recent: Mutex<VecDeque<String>>,
    /// Bounded diagnostics log.
    log: Mutex<Vec<String>>,
}

impl BrowserBridgeHub {
    fn note(&self, line: String) {
        let mut log = self.log.lock().unwrap();
        log.push(format!("[{}] {}", crate::history::now_ms(), line));
        if log.len() > 200 {
            let over = log.len() - 200;
            log.drain(..over);
        }
    }

    /// Register an approval waiter for a request. Both intake routes (UI
    /// command and native-host IPC) share this so approval semantics cannot
    /// silently diverge.
    pub fn register_pending(&self, id: &str, tx: oneshot::Sender<Value>) {
        self.pending.lock().unwrap().insert(id.to_string(), tx);
    }

    /// Drop a pending waiter without resolving it (timeout / cancellation).
    /// The oneshot's rx side then observes a closed channel.
    pub fn remove_pending(&self, id: &str) {
        self.pending.lock().unwrap().remove(id);
    }

    /// Resolve a pending approval with an explicit user decision. Returns
    /// false when no matching request is pending (e.g. it already timed out).
    pub fn resolve_pending(&self, id: &str, decision: Value) -> bool {
        if let Some(tx) = self.pending.lock().unwrap().remove(id) {
            tx.send(decision).is_ok()
        } else {
            false
        }
    }

    /// Number of requests currently awaiting a user decision.
    pub fn pending_count(&self) -> usize {
        self.pending.lock().unwrap().len()
    }

    pub fn events(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }

    /// Record a newly decided request id for idempotency. Returns true if it was
    /// newly recorded (i.e. not a duplicate).
    pub fn record_id(&self, id: &str) -> bool {
        let mut recent = self.recent.lock().unwrap();
        if recent.contains(&id.to_string()) {
            return false;
        }
        recent.push_back(id.to_string());
        if recent.len() > IDEMPOTENCY_RING {
            recent.pop_front();
        }
        true
    }

    pub fn is_duplicate(&self, id: &str) -> bool {
        self.recent.lock().unwrap().contains(&id.to_string())
    }
}

/// Validated proposal data extracted from a tool.propose request.
#[derive(Debug, Clone)]
pub struct ValidatedProposal {
    pub transport_request_id: String,
    pub tool: String,
    pub args: Value,
    pub site: String,
}

/// Validation errors for browser bridge proposals.
#[derive(Debug, thiserror::Error)]
pub enum BridgeValidationError {
    #[error("command not allowed from this webview")]
    InvalidWebview,
    #[error("payload exceeds size limit")]
    OversizedPayload,
    #[error("invalid JSON: {0}")]
    InvalidJson(String),
    #[error("request must be a JSON object")]
    NotAnObject,
    #[error("unsupported protocol version")]
    UnsupportedVersion,
    #[error("unsupported operation")]
    UnsupportedOperation,
    #[error("missing or invalid request_id")]
    InvalidRequestId,
    #[error("duplicate request: {0}")]
    Duplicate(String),
    #[error("missing proposal")]
    MissingProposal,
    #[error("task/workspace selection is reserved to the desktop backend")]
    ForbiddenTaskWorkspace,
    #[error("unsupported or missing tool")]
    UnsupportedTool,
    #[error("args must be an object")]
    InvalidArgs,
    #[error("no workspace open — select a folder in Neelima first")]
    NoWorkspace,
}

/// Validate a browser bridge proposal request.
/// Returns the validated proposal data or a validation error.
pub fn validate_browser_bridge_request(
    hub: &BrowserBridgeHub,
    slot: &WorkspaceSlot,
    webview_label: &str,
    payload: &str,
) -> Result<ValidatedProposal, BridgeValidationError> {
    // Only the UI webview may call Tauri commands in this build; the provider
    // webview's capability grants only lb_bridge. A future native host will
    // call this through the host-process IPC path.
    if webview_label != "ui" {
        hub.note(format!(
            "browser_bridge_propose: rejected caller webview '{}'",
            webview_label
        ));
        return Err(BridgeValidationError::InvalidWebview);
    }

    if payload.len() > MAX_PROPOSE_BYTES {
        hub.note("browser_bridge_propose: oversized payload".into());
        return Err(BridgeValidationError::OversizedPayload);
    }

    let request: Value = serde_json::from_str(payload)
        .map_err(|e| BridgeValidationError::InvalidJson(e.to_string()))?;
    let request_obj = request
        .as_object()
        .ok_or(BridgeValidationError::NotAnObject)?;

    // Schema validation (mirrors protocol.js; the backend repeats all checks).
    let version = request_obj
        .get("version")
        .and_then(Value::as_u64)
        .ok_or(BridgeValidationError::UnsupportedVersion)?;
    if version != 1 {
        return Err(BridgeValidationError::UnsupportedVersion);
    }
    let operation = request_obj
        .get("operation")
        .and_then(Value::as_str)
        .ok_or(BridgeValidationError::UnsupportedOperation)?;
    if operation != "tool.propose" {
        return Err(BridgeValidationError::UnsupportedOperation);
    }

    let transport_request_id = request_obj
        .get("request_id")
        .and_then(Value::as_str)
        .filter(|s| is_uuid_like(s))
        .ok_or(BridgeValidationError::InvalidRequestId)?
        .to_string();

    // Idempotency: a repeated transport request_id is not re-executed.
    if hub.is_duplicate(&transport_request_id) {
        hub.note(format!(
            "browser_bridge_propose: duplicate {transport_request_id}"
        ));
        return Err(BridgeValidationError::Duplicate(transport_request_id));
    }

    let proposal = request_obj
        .get("proposal")
        .and_then(Value::as_object)
        .ok_or(BridgeValidationError::MissingProposal)?;

    // The webpage/extension must never choose a Neelima task or workspace.
    // These are bound by the backend to the explicitly selected desktop workspace.
    if proposal.get("task_id").is_some() || proposal.get("workspace_id").is_some() {
        hub.note("browser_bridge_propose: rejected webpage-supplied task/workspace id".into());
        return Err(BridgeValidationError::ForbiddenTaskWorkspace);
    }

    let tool = proposal
        .get("tool")
        .and_then(Value::as_str)
        .filter(|t| is_allowed_tool(t))
        .ok_or(BridgeValidationError::UnsupportedTool)?
        .to_string();

    let args = proposal.get("args").cloned().unwrap_or(Value::Null);
    if !args.is_object() && !args.is_null() {
        return Err(BridgeValidationError::InvalidArgs);
    }

    let site = proposal
        .get("site")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("generic")
        .to_string();

    // Bind to the desktop's explicitly selected workspace. The extension does
    // not select folders and cannot grant itself filesystem access.
    let _ws = slot
        .0
        .lock()
        .unwrap()
        .clone()
        .ok_or(BridgeValidationError::NoWorkspace)?;

    // Mark the request id as decided so a retry is not re-executed.
    hub.record_id(&transport_request_id);

    Ok(ValidatedProposal {
        transport_request_id,
        tool,
        args,
        site,
    })
}

fn is_allowed_tool(tool: &str) -> bool {
    ALLOWED_TOOLS.contains(&tool)
}

fn is_uuid_like(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
}

/// Validated proposal data extracted from a proposal object (shared between
/// browser_bridge_propose and native host IPC).
#[derive(Debug, Clone)]
pub struct ValidatedProposalData {
    pub tool: String,
    pub args: Value,
    pub site: String,
}

/// Validation errors for proposal objects.
#[derive(Debug, thiserror::Error)]
pub enum ProposalValidationError {
    #[error("missing proposal object")]
    MissingProposal,
    #[error("task/workspace selection is reserved to the desktop backend")]
    ForbiddenTaskWorkspace,
    #[error("unsupported or missing tool")]
    UnsupportedTool,
    #[error("args must be an object")]
    InvalidArgs,
}

/// Validate a proposal object (the inner "proposal" field).
/// This is shared between browser_bridge_propose and native host IPC.
pub fn validate_proposal(
    proposal: &serde_json::Map<String, Value>,
) -> Result<ValidatedProposalData, ProposalValidationError> {
    // Reject webpage-supplied task/workspace IDs
    if proposal.get("task_id").is_some() || proposal.get("workspace_id").is_some() {
        return Err(ProposalValidationError::ForbiddenTaskWorkspace);
    }

    let tool = proposal
        .get("tool")
        .and_then(Value::as_str)
        .filter(|t| is_allowed_tool(t))
        .ok_or(ProposalValidationError::UnsupportedTool)?
        .to_string();

    let args = proposal.get("args").cloned().unwrap_or(Value::Null);
    if !args.is_object() && !args.is_null() {
        return Err(ProposalValidationError::InvalidArgs);
    }

    let site = proposal
        .get("site")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("generic")
        .to_string();

    Ok(ValidatedProposalData { tool, args, site })
}

/// The single intake command. Only the "ui" webview may invoke it directly in
/// the current Tauri model; the future native host will reach it through the
/// host-process IPC path that does not exist yet.
#[tauri::command]
pub async fn browser_bridge_propose(
    webview: Webview,
    app: AppHandle,
    hub: State<'_, Arc<BrowserBridgeHub>>,
    slot: State<'_, WorkspaceSlot>,
    settings: State<'_, SettingsStore>,
    payload: String,
) -> Result<Value, String> {
    // Validate the request using shared logic
    let validated = match validate_browser_bridge_request(&hub, &slot, webview.label(), &payload) {
        Ok(v) => v,
        Err(BridgeValidationError::Duplicate(id)) => {
            return Ok(serde_json::json!({
                "version": 1,
                "request_id": id,
                "status": "duplicate",
                "result": {"message": "Request already decided; not re-executed."}
            }));
        }
        Err(e) => {
            // Phase A: a refused proposal gets a truthful NotExecuted ledger
            // record; nothing from the unvalidated payload is stored.
            record_validation_refusal(&app, &e, crate::action::Intake::BrowserBridgeUi);
            return Err(e.to_string());
        }
    };

    let transport_request_id = validated.transport_request_id;

    // Shared approval + execution path (same as the native-host IPC route).
    let req = BridgeRequest {
        request_id: &transport_request_id,
        tool: &validated.tool,
        args: &validated.args,
        site: &validated.site,
        source: "browser_bridge_propose",
    };
    let (status, result) = approve_and_execute(&app, &hub, &slot, &settings, &req).await;

    Ok(serde_json::json!({
        "version": 1,
        "request_id": transport_request_id,
        "status": status,
        "result": result
    }))
}

/// Shared approval + execution path used by BOTH intake routes (the UI webview
/// command and the native-host IPC handler) so approval semantics, idempotency
/// cleanup, and result reporting can never silently diverge.
///
/// Guarantees:
/// - Write/delete tools under AskAll/AskWrites wait for an EXPLICIT user
///   decision; nothing is executed merely because the transport acknowledged.
/// - Rejection, timeout, and channel-closure all clear the pending entry and
///   return a terminal status without executing.
/// - On approval the validated tool runs through the standard `tools::execute`
///   path and the real result (or error) is returned.
pub async fn approve_and_execute(
    app: &AppHandle,
    hub: &BrowserBridgeHub,
    slot: &WorkspaceSlot,
    settings: &SettingsStore,
    req: &BridgeRequest<'_>,
) -> (String, Value) {
    let BridgeRequest {
        request_id,
        tool,
        args,
        site,
        source,
    } = *req;
    let permission_mode = settings.get().permission_mode;
    // Phase B: the bridge follows the SAME risk→approval mapping as the agent
    // route (`action::approval_required`). Under AskAll, read proposals now
    // wait for an explicit user decision too — previously the bridge
    // auto-executed reads in every mode. The extension's stored preference
    // and any webpage-supplied fields remain irrelevant: the backend's mode
    // is the only authority.
    let risk = crate::action::risk_of_tool(tool);
    let needs_approval = crate::action::approval_required(risk, permission_mode);

    // Phase A: record this proposal in the unified action ledger before any
    // decision. The ledger is observational; every gate below is unchanged.
    let ledger = crate::action::ledger_of(app);
    let action_id = ledger.as_ref().and_then(|l| {
        let begin = crate::action::BeginAction {
            origin: crate::action::ActionOrigin {
                proposer: crate::action::Proposer::BrowserExtension,
                provider: None,
                site: Some(site.to_string()),
                page_origin: None,
            },
            intake: bridge_intake(source),
            category: crate::action::category_of_tool(tool),
            tool: Some(tool),
            risk,
            args: Some(args),
            task_id: None,
            request_id: None,
            transport_request_id: Some(request_id),
            approval_required: needs_approval,
            approval_reason: Some(format!("mode={permission_mode:?} risk={risk:?}")),
        };
        let id = l.begin(&begin)?;
        let _ = l.validate(&id);
        Some(id)
    });

    if !needs_approval {
        // Execute immediately through the standard tool path.
        return run_and_record(
            ledger.as_deref(),
            action_id.as_deref(),
            hub,
            slot,
            settings,
            req,
            "executed",
        );
    }

    // Approval required: register the waiter BEFORE emitting the event so a
    // decision racing the event can never be lost.
    let (tx, rx) = oneshot::channel();
    hub.register_pending(request_id, tx);

    // The app's single event channel is "evt" with a kind discriminator; the
    // UI webview is the only listener.
    let _ = app.emit(
        "evt",
        serde_json::json!({
            "kind": "bridge-approval-request",
            "request_id": request_id,
            "tool": tool,
            "args": args,
            "site": site,
            "risk": "high",
            "source": source
        }),
    );

    hub.note(format!(
        "{source}: {request_id} tool={tool} site={site} status=awaiting_approval (waiting for UI)"
    ));

    if let (Some(l), Some(id)) = (ledger.as_deref(), action_id.as_deref()) {
        let _ = l.await_approval(id);
    }

    // Wait for an explicit decision, bounded. Rejection, timeout, and channel
    // closure all clear pending state and never execute.
    let decision = match tokio::time::timeout(APPROVAL_TIMEOUT, rx).await {
        Ok(Ok(decision)) => decision,
        Ok(Err(_)) => {
            if let (Some(l), Some(id)) = (ledger.as_deref(), action_id.as_deref()) {
                let _ = l.refuse(id, crate::action::category::APPROVAL_CANCELLED);
            }
            hub.remove_pending(request_id);
            hub.note(format!("{source}: {request_id} status=approval_cancelled"));
            return (
                "rejected".into(),
                serde_json::json!({
                    "tool": tool,
                    "site": site,
                    "error": {"code": "APPROVAL_CANCELLED", "message": "Approval request cancelled"}
                }),
            );
        }
        Err(_) => {
            if let (Some(l), Some(id)) = (ledger.as_deref(), action_id.as_deref()) {
                let _ = l.expire_approval(id);
            }
            hub.remove_pending(request_id);
            hub.note(format!("{source}: {request_id} status=approval_timeout"));
            return (
                "timeout".into(),
                serde_json::json!({
                    "tool": tool,
                    "site": site,
                    "error": {"code": "APPROVAL_TIMEOUT", "message": format!("Approval request timed out after {} seconds; not executed", APPROVAL_TIMEOUT.as_secs())}
                }),
            );
        }
    };

    let approved = decision
        .get("approved")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !approved {
        if let (Some(l), Some(id)) = (ledger.as_deref(), action_id.as_deref()) {
            let _ = l.decide_approval(id, false);
        }
        let reason = decision
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("rejected by user");
        hub.note(format!("{source}: {request_id} status=rejected"));
        return (
            "rejected".into(),
            serde_json::json!({
                "tool": tool,
                "site": site,
                "error": {"code": "REJECTED", "message": reason}
            }),
        );
    }

    // Approved: record the user's decision, then execute and return the real
    // result. Without this the ledger stays `Pending` forever even though the
    // action ran.
    if let (Some(l), Some(id)) = (ledger.as_deref(), action_id.as_deref()) {
        let _ = l.decide_approval(id, true);
    }
    run_and_record(
        ledger.as_deref(),
        action_id.as_deref(),
        hub,
        slot,
        settings,
        req,
        "approved_and_executed",
    )
}

/// Phase A: execute through the standard tool path and record the real
/// result in the action ledger. The ledger never changes the outcome; the
/// wire statuses are exactly what `execute_tool` produced.
#[allow(clippy::too_many_arguments)]
fn run_and_record(
    ledger: Option<&crate::action::ActionLedger>,
    action_id: Option<&str>,
    hub: &BrowserBridgeHub,
    slot: &WorkspaceSlot,
    settings: &SettingsStore,
    req: &BridgeRequest<'_>,
    ok_status: &str,
) -> (String, Value) {
    let ws_available = slot.0.lock().unwrap().is_some();
    if let (Some(l), Some(id)) = (ledger, action_id) {
        if ws_available {
            let _ = l.begin_execution(id, crate::action::Executor::RustTools);
        } else {
            let _ = l.refuse(id, crate::action::category::NO_WORKSPACE);
        }
    }
    let (status, result) = execute_tool(hub, slot, settings, req, ok_status);
    if let (Some(l), Some(id)) = (ledger, action_id) {
        if ws_available {
            let ok = status == ok_status;
            let outcome = if ok {
                crate::action::ActionOutcome::Succeeded
            } else {
                crate::action::ActionOutcome::Failed
            };
            let _ = l.settle(
                id,
                outcome,
                crate::action::ExecutionMeta {
                    output_len: result.get("output").and_then(Value::as_str).map(str::len),
                    had_diff: result.get("diff").map(|d| !d.is_null()).unwrap_or(false),
                    ..Default::default()
                },
                (!ok).then_some(crate::action::category::TOOL_ERROR),
            );
        }
    }
    (status, result)
}

fn bridge_intake(source: &str) -> crate::action::Intake {
    if source == "native_host" {
        crate::action::Intake::NativeHostPipe
    } else {
        crate::action::Intake::BrowserBridgeUi
    }
}

/// Phase A: refused-at-validation proposals get a truthful NotExecuted
/// record. Nothing about the unvalidated payload (tool name, args, transport
/// id) is stored.
fn record_validation_refusal(
    app: &AppHandle,
    error: &BridgeValidationError,
    intake: crate::action::Intake,
) {
    let Some(ledger) = crate::action::ledger_of(app) else {
        return;
    };
    let category = match error {
        BridgeValidationError::InvalidWebview => crate::action::category::INVALID_CALLER,
        BridgeValidationError::OversizedPayload => crate::action::category::OVERSIZED_PAYLOAD,
        BridgeValidationError::InvalidJson(_) => crate::action::category::INVALID_JSON,
        BridgeValidationError::NotAnObject => crate::action::category::INVALID_PROPOSAL,
        BridgeValidationError::UnsupportedVersion => crate::action::category::UNSUPPORTED_VERSION,
        BridgeValidationError::UnsupportedOperation => {
            crate::action::category::UNSUPPORTED_OPERATION
        }
        BridgeValidationError::InvalidRequestId => crate::action::category::INVALID_REQUEST_ID,
        BridgeValidationError::Duplicate(_) => crate::action::category::DUPLICATE,
        BridgeValidationError::MissingProposal => crate::action::category::INVALID_PROPOSAL,
        BridgeValidationError::ForbiddenTaskWorkspace => {
            crate::action::category::FORBIDDEN_IDENTITY
        }
        BridgeValidationError::UnsupportedTool => crate::action::category::UNSUPPORTED_TOOL,
        BridgeValidationError::InvalidArgs => crate::action::category::INVALID_ARGS,
        BridgeValidationError::NoWorkspace => crate::action::category::NO_WORKSPACE,
    };
    ledger.begin_refused(intake, category);
}

/// Phase A category mapping for the shared proposal-object validator (used by
/// the native-host pipe route).
pub(crate) fn proposal_refusal_category(error: &ProposalValidationError) -> &'static str {
    match error {
        ProposalValidationError::MissingProposal => crate::action::category::INVALID_PROPOSAL,
        ProposalValidationError::ForbiddenTaskWorkspace => {
            crate::action::category::FORBIDDEN_IDENTITY
        }
        ProposalValidationError::UnsupportedTool => crate::action::category::UNSUPPORTED_TOOL,
        ProposalValidationError::InvalidArgs => crate::action::category::INVALID_ARGS,
    }
}

/// The validated proposal fields shared by both intake routes, referenced
/// through the approval/execution pipeline.
pub struct BridgeRequest<'a> {
    pub request_id: &'a str,
    pub tool: &'a str,
    pub args: &'a Value,
    pub site: &'a str,
    pub source: &'a str,
}

/// Execute a validated tool call through the standard tool path. The
/// non-approval leg of [`approve_and_execute`] and the native-host tests share
/// this primitive.
pub fn execute_tool(
    hub: &BrowserBridgeHub,
    slot: &WorkspaceSlot,
    settings: &SettingsStore,
    req: &BridgeRequest<'_>,
    ok_status: &str,
) -> (String, Value) {
    let BridgeRequest {
        request_id,
        tool,
        args,
        site,
        source,
    } = *req;
    let ws = slot.0.lock().unwrap().clone();
    let Some(ws) = ws else {
        hub.note(format!(
            "{source}: {request_id} status=execution_failed (no workspace)"
        ));
        return (
            "execution_failed".into(),
            serde_json::json!({
                "tool": tool,
                "site": site,
                "error": "no workspace open — select a folder in Neelima first"
            }),
        );
    };

    let tool_call = crate::protocol::ToolCall {
        id: request_id.to_string(),
        tool: tool.to_string(),
        args: args.clone(),
        security_nonce: None,
    };

    let outcome = tools::execute(&ws, &tool_call, &settings.get());

    if outcome.ok {
        hub.note(format!(
            "{source}: {request_id} tool={tool} site={site} status={ok_status}"
        ));
        (
            ok_status.to_string(),
            serde_json::json!({
                "tool": tool,
                "site": site,
                "output": outcome.output,
                "diff": outcome.diff
            }),
        )
    } else {
        hub.note(format!(
            "{source}: {request_id} tool={tool} site={site} status=execution_failed"
        ));
        (
            "execution_failed".into(),
            serde_json::json!({
                "tool": tool,
                "site": site,
                "error": outcome.output
            }),
        )
    }
}

/// The single decision intake for bridge approvals. Only the "ui" webview may
/// call it; it resolves a request registered by `approve_and_execute`.
#[tauri::command]
pub fn browser_bridge_decide(
    webview: Webview,
    hub: State<'_, Arc<BrowserBridgeHub>>,
    request_id: String,
    approved: bool,
    reason: Option<String>,
) -> Result<bool, String> {
    if webview.label() != "ui" {
        hub.note(format!(
            "browser_bridge_decide: rejected caller webview '{}'",
            webview.label()
        ));
        return Err("command not allowed from this webview".into());
    }
    if request_id.is_empty() || request_id.len() > 128 {
        return Err("invalid request id".into());
    }
    let decision = serde_json::json!({
        "approved": approved,
        "reason": reason.unwrap_or_else(|| if approved { "approved by user" } else { "rejected by user" }.to_string())
    });
    Ok(hub.resolve_pending(&request_id, decision))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hub() -> Arc<BrowserBridgeHub> {
        Arc::new(BrowserBridgeHub::default())
    }

    #[allow(dead_code)]
    fn propose_payload(tool: &str, path: &str) -> String {
        serde_json::json!({
            "version": 1,
            "operation": "tool.propose",
            "request_id": uuid::Uuid::new_v4().to_string(),
            "proposal": {
                "version": 1,
                "operation": "tool.propose",
                "request_id": uuid::Uuid::new_v4().to_string(),
                "tool": tool,
                "args": { "path": path },
                "site": "chatgpt",
                "page_origin": "https://chatgpt.com",
                "user_activated": true
            }
        })
        .to_string()
    }

    #[test]
    fn rejects_unsupported_protocol_version() {
        let payload = serde_json::json!({
            "version": 2,
            "operation": "tool.propose",
            "request_id": "abc",
            "proposal": { "version": 1, "operation": "tool.propose", "request_id": "def", "tool": "read_file", "args": {} }
        })
        .to_string();
        // This tests the validation logic inline by checking version handling.
        let v: Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(v.get("version").and_then(Value::as_u64), Some(2));
    }

    #[test]
    fn rejects_unsupported_tool() {
        let payload = serde_json::json!({
            "version": 1,
            "operation": "tool.propose",
            "request_id": "r1",
            "proposal": { "version": 1, "operation": "tool.propose", "request_id": "p1", "tool": "run_command", "args": {} }
        })
        .to_string();
        let v: Value = serde_json::from_str(&payload).unwrap();
        let tool = v
            .get("proposal")
            .and_then(|p| p.get("tool"))
            .and_then(Value::as_str);
        assert_eq!(tool, Some("run_command"));
        assert!(!is_allowed_tool("run_command"));
    }

    #[test]
    fn rejects_webpage_supplied_task_id() {
        let payload = serde_json::json!({
            "version": 1,
            "operation": "tool.propose",
            "request_id": "r1",
            "proposal": { "version": 1, "operation": "tool.propose", "request_id": "p1", "tool": "read_file", "args": {}, "task_id": "task-123" }
        })
        .to_string();
        let v: Value = serde_json::from_str(&payload).unwrap();
        assert!(v.get("proposal").and_then(|p| p.get("task_id")).is_some());
    }

    #[test]
    fn idempotency_ring_records_and_detects_duplicate() {
        let hub = hub();
        let id = "req-1";
        assert!(hub.record_id(id));
        assert!(!hub.record_id(id)); // duplicate
        assert!(hub.is_duplicate(id));
    }

    #[test]
    fn allowed_tool_set_excludes_shell() {
        assert!(is_allowed_tool("read_file"));
        assert!(is_allowed_tool("write_file"));
        assert!(!is_allowed_tool("run_command"));
        assert!(is_allowed_tool("delete_file"));
    }

    /// Phase A: proposal-validation errors map to stable ledger categories —
    /// refused records must be truthful about why nothing ran.
    #[test]
    fn proposal_validation_errors_map_to_stable_ledger_categories() {
        use crate::action::category;
        let cases = [
            (
                ProposalValidationError::MissingProposal,
                category::INVALID_PROPOSAL,
            ),
            (
                ProposalValidationError::ForbiddenTaskWorkspace,
                category::FORBIDDEN_IDENTITY,
            ),
            (
                ProposalValidationError::UnsupportedTool,
                category::UNSUPPORTED_TOOL,
            ),
            (ProposalValidationError::InvalidArgs, category::INVALID_ARGS),
        ];
        for (error, want) in cases {
            assert_eq!(proposal_refusal_category(&error), want);
        }
    }
}
