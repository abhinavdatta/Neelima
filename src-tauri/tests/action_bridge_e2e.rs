//! Integration test (Phase A): the browser-bridge propose → approve → execute
//! path records unified action-ledger entries without changing any wire
//! behavior.
//!
//! The harness builds a bare headless Tauri app (same trick as
//! agent_loop_e2e.rs: `.any_thread()`; `tauri.conf.json` defines no windows,
//! so no event loop needs to run). `approve_and_execute` takes plain
//! references, so each spawned task owns `Arc`-wrapped hub/slot/settings and
//! borrows them inside the task; only the ledger must be MANAGED on the app
//! (that is how the route looks it up). Every wire status asserted here is
//! the pre-existing behavior also pinned by `browser_bridge_test.rs`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use neelima_lib::action::{
    ActionLedger, ActionOutcome, ApprovalStatus, Executor, Intake, Proposer,
};
use neelima_lib::browser_bridge::{self, BridgeRequest, BrowserBridgeHub};
use neelima_lib::settings::{PermissionMode, SettingsStore};
use neelima_lib::ui::WorkspaceSlot;
use neelima_lib::workspace::Workspace;
use serde_json::{json, Value};
use tauri::Manager;

fn headless_app() -> tauri::AppHandle {
    let app = tauri::Builder::default()
        .any_thread()
        .build(tauri::generate_context!())
        .expect("headless Tauri app builds");
    let handle = app.handle().clone();
    handle.manage(Arc::new(ActionLedger::default()));
    handle
}

fn settings_for(mode: PermissionMode) -> Arc<SettingsStore> {
    let dir = std::env::temp_dir().join(format!(
        "neelima-action-e2e-hist-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&dir).expect("settings dir created");
    let settings = SettingsStore::load(&dir).expect("settings load");
    settings
        .patch(|s| s.permission_mode = mode)
        .expect("mode set");
    Arc::new(settings)
}

fn workspace_slot() -> Arc<WorkspaceSlot> {
    let ws_dir = std::env::temp_dir().join(format!(
        "neelima-action-e2e-ws-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&ws_dir).expect("workspace created");
    std::fs::write(ws_dir.join("notes.txt"), "bridge probe").expect("seed file written");
    Arc::new(WorkspaceSlot(Mutex::new(Some(
        Workspace::open(&ws_dir).expect("workspace opens"),
    ))))
}

fn read_request<'a>(request_id: &'a str, args: &'a Value) -> BridgeRequest<'a> {
    BridgeRequest {
        request_id,
        tool: "read_file",
        args,
        site: "chatgpt",
        source: "native_host",
    }
}

/// Spawn `approve_and_execute` on owned state; the task borrows the Arcs
/// internally so the 'static bounds hold.
fn spawn_propose(
    handle: &tauri::AppHandle,
    hub: &Arc<BrowserBridgeHub>,
    slot: &Arc<WorkspaceSlot>,
    settings: &Arc<SettingsStore>,
    request_id: String,
    tool: &'static str,
    args: Value,
) -> tokio::task::JoinHandle<(String, Value)> {
    let handle = handle.clone();
    let hub = hub.clone();
    let slot = slot.clone();
    let settings = settings.clone();
    tokio::spawn(async move {
        let req = BridgeRequest {
            request_id: &request_id,
            tool,
            args: &args,
            site: "chatgpt",
            source: "native_host",
        };
        browser_bridge::approve_and_execute(&handle, &hub, &slot, &settings, &req).await
    })
}

/// Wait (bounded) until the bridge reports a pending approval.
async fn wait_pending(hub: &BrowserBridgeHub) {
    for _ in 0..300 {
        if hub.pending_count() > 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("approval never became pending");
}

#[tokio::test]
async fn read_tool_executes_and_records_success_without_approval() {
    let handle = headless_app();
    let hub = Arc::new(BrowserBridgeHub::default());
    let slot = workspace_slot();
    let settings = settings_for(PermissionMode::AskWrites);
    let request_id = uuid::Uuid::new_v4().to_string();
    let args = json!({"path": "notes.txt"});
    let req = read_request(&request_id, &args);

    let (status, result) =
        browser_bridge::approve_and_execute(&handle, &hub, &slot, &settings, &req).await;

    // Wire behavior unchanged.
    assert_eq!(status, "executed");
    assert_eq!(result["output"], "bridge probe");
    assert!(result.get("error").is_none());

    let ledger = handle.state::<Arc<ActionLedger>>();
    assert_eq!(ledger.count(), 1);
    let record = ledger.find_by_transport(&request_id).expect("recorded");
    assert_eq!(record.origin.proposer, Proposer::BrowserExtension);
    assert_eq!(record.origin.site.as_deref(), Some("chatgpt"));
    assert_eq!(record.intake, Intake::NativeHostPipe, "source=native_host");
    assert!(
        !record.approval.required,
        "reads never hit the approval gate"
    );
    assert_eq!(record.approval.status, ApprovalStatus::NotRequired);
    assert_eq!(record.outcome, Some(ActionOutcome::Succeeded));
    let execution = record.execution.as_ref().expect("executed");
    assert_eq!(execution.executor, Executor::RustTools);
    assert_eq!(execution.output_len, Some("bridge probe".len()));
    assert!(!execution.had_diff);
    assert!(execution.duration_ms.is_some());
    assert_eq!(record.descriptor.tool.as_deref(), Some("read_file"));
    assert_eq!(record.descriptor.primary_path.as_deref(), Some("notes.txt"));
}

#[tokio::test]
async fn write_tool_rejected_by_user_records_not_executed() {
    let handle = headless_app();
    let hub = Arc::new(BrowserBridgeHub::default());
    let slot = workspace_slot();
    let settings = settings_for(PermissionMode::AskWrites);
    let request_id = uuid::Uuid::new_v4().to_string();
    let args = json!({"path": "notes.txt", "content": "replacement"});

    let task = spawn_propose(
        &handle,
        &hub,
        &slot,
        &settings,
        request_id.clone(),
        "write_file",
        args,
    );
    wait_pending(&hub).await;
    assert!(
        hub.resolve_pending(&request_id, json!({"approved": false})),
        "the decision reaches the pending approval"
    );
    let (status, result) = task.await.expect("task completes");

    // Wire behavior unchanged (explicit rejection, nothing executed).
    assert_eq!(status, "rejected");
    assert_eq!(result["error"]["code"], "REJECTED");

    let ledger = handle.state::<Arc<ActionLedger>>();
    let record = ledger.find_by_transport(&request_id).expect("recorded");
    assert!(record.approval.required);
    assert_eq!(record.approval.status, ApprovalStatus::Rejected);
    assert_eq!(record.approval.decision_source.as_deref(), Some("user_ui"));
    assert!(record.approval.decided_at_ms.is_some());
    assert_eq!(record.outcome, Some(ActionOutcome::NotExecuted));
    assert_eq!(
        record.error_category.as_deref(),
        Some(neelima_lib::action::category::APPROVAL_REJECTED)
    );
    assert!(
        record.execution.is_none(),
        "rejection must not imply execution"
    );
}

#[tokio::test]
async fn write_tool_approved_records_success() {
    let handle = headless_app();
    let hub = Arc::new(BrowserBridgeHub::default());
    let slot = workspace_slot();
    let settings = settings_for(PermissionMode::AskWrites);
    let request_id = uuid::Uuid::new_v4().to_string();
    let args = json!({"path": "notes.txt", "content": "approved content"});

    let task = spawn_propose(
        &handle,
        &hub,
        &slot,
        &settings,
        request_id.clone(),
        "write_file",
        args,
    );
    wait_pending(&hub).await;
    assert!(hub.resolve_pending(&request_id, json!({"approved": true})));
    let (status, result) = task.await.expect("task completes");

    // Wire behavior unchanged (real result after approval).
    assert_eq!(status, "approved_and_executed");
    assert!(result["output"]
        .as_str()
        .unwrap_or_default()
        .contains("notes.txt"));

    let ledger = handle.state::<Arc<ActionLedger>>();
    let record = ledger.find_by_transport(&request_id).expect("recorded");
    assert_eq!(record.approval.status, ApprovalStatus::Approved);
    assert_eq!(record.outcome, Some(ActionOutcome::Succeeded));
    assert_eq!(
        record.execution.as_ref().unwrap().executor,
        Executor::RustTools
    );
    assert!(record.execution.as_ref().unwrap().had_diff);
    // Metadata-only: the written content is not in the record.
    let serialized = serde_json::to_string(&record).unwrap();
    assert!(!serialized.contains("approved content"));
}

/// The approval window lapsing (backend budget 120 s) records an EXPIRY —
/// distinct from a user rejection — and still returns the transport-timeout
/// status the extension expects.
#[tokio::test(start_paused = true)]
async fn approval_expiration_records_expired_not_executed() {
    let handle = headless_app();
    let hub = Arc::new(BrowserBridgeHub::default());
    let slot = workspace_slot();
    let settings = settings_for(PermissionMode::AskWrites);
    let request_id = uuid::Uuid::new_v4().to_string();
    let args = json!({"path": "notes.txt", "content": "nobody approves this"});

    let task = spawn_propose(
        &handle,
        &hub,
        &slot,
        &settings,
        request_id.clone(),
        "write_file",
        args,
    );
    wait_pending(&hub).await;
    // One more yield so the spawned task registers its 120 s timer.
    tokio::time::sleep(Duration::from_millis(1)).await;
    tokio::time::advance(Duration::from_secs(
        neelima_lib::browser_bridge::APPROVAL_TIMEOUT.as_secs() + 1,
    ))
    .await;
    let (status, result) = task.await.expect("task completes");

    // Wire behavior unchanged.
    assert_eq!(status, "timeout");
    assert_eq!(result["error"]["code"], "APPROVAL_TIMEOUT");

    let ledger = handle.state::<Arc<ActionLedger>>();
    let record = ledger.find_by_transport(&request_id).expect("recorded");
    assert_eq!(record.approval.status, ApprovalStatus::Expired);
    assert!(record.approval.decided_at_ms.is_none());
    assert_eq!(record.outcome, Some(ActionOutcome::NotExecuted));
    assert_eq!(
        record.error_category.as_deref(),
        Some(neelima_lib::action::category::APPROVAL_EXPIRED)
    );
    assert!(record.execution.is_none());
}

/// The ledger refuses to give a duplicate transport request a second
/// lifecycle. (Execution-level dedupe remains the hub's job — replaying the
/// same id through the real intake is refused there, see
/// browser_bridge_test.rs.)
#[tokio::test]
async fn duplicate_transport_request_id_records_once() {
    let handle = headless_app();
    let hub = Arc::new(BrowserBridgeHub::default());
    let slot = workspace_slot();
    let settings = settings_for(PermissionMode::AskWrites);
    let request_id = uuid::Uuid::new_v4().to_string();
    let args = json!({"path": "notes.txt"});
    let req = read_request(&request_id, &args);

    let (first_status, _) =
        browser_bridge::approve_and_execute(&handle, &hub, &slot, &settings, &req).await;
    assert_eq!(first_status, "executed");
    let (second_status, _) =
        browser_bridge::approve_and_execute(&handle, &hub, &slot, &settings, &req).await;
    assert_eq!(second_status, "executed");

    let ledger = handle.state::<Arc<ActionLedger>>();
    assert_eq!(
        ledger.count(),
        1,
        "no second lifecycle for the same transport id"
    );
    let record = ledger.find_by_transport(&request_id).unwrap();
    assert_eq!(record.outcome, Some(ActionOutcome::Succeeded));
}

/// Without an open workspace nothing executes — and the ledger records the
/// refusal truthfully instead of a failed execution.
#[tokio::test]
async fn no_workspace_refusal_records_not_executed() {
    let handle = headless_app();
    let hub = Arc::new(BrowserBridgeHub::default());
    let slot = Arc::new(WorkspaceSlot(Mutex::new(None)));
    let settings = settings_for(PermissionMode::AskWrites);
    let request_id = uuid::Uuid::new_v4().to_string();
    let args = json!({"path": "notes.txt"});
    let req = read_request(&request_id, &args);

    let (status, result) =
        browser_bridge::approve_and_execute(&handle, &hub, &slot, &settings, &req).await;

    // Wire behavior unchanged.
    assert_eq!(status, "execution_failed");
    assert!(
        result["error"]
            .as_str()
            .unwrap_or_default()
            .contains("no workspace open"),
        "error: {}",
        result["error"]
    );

    let ledger = handle.state::<Arc<ActionLedger>>();
    let record = ledger.find_by_transport(&request_id).expect("recorded");
    assert_eq!(record.outcome, Some(ActionOutcome::NotExecuted));
    assert_eq!(
        record.error_category.as_deref(),
        Some(neelima_lib::action::category::NO_WORKSPACE)
    );
    assert!(record.execution.is_none(), "nothing ran");
}
