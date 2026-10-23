//! Integration tests for the browser extension native-message request router
//! (`src-tauri/src/browser_bridge.rs`).
//!
//! These tests exercise the public surface of `BrowserBridgeHub` and the
//! exported protocol constants. The full `browser_bridge_propose` command is
//! a Tauri command (requires `State`/`Webview` runtime) and is covered by the
//! module's own `#[cfg(test)]` tests; this file tests the public validation
//! primitives and idempotency behavior in isolation.

use neelima_lib::browser_bridge::{self, ALLOWED_TOOLS, MAX_PROPOSE_BYTES};

#[test]
fn allowed_tool_set_excludes_shell_and_includes_file_tools() {
    assert!(ALLOWED_TOOLS.contains(&"read_file"));
    assert!(ALLOWED_TOOLS.contains(&"list_dir"));
    assert!(ALLOWED_TOOLS.contains(&"grep"));
    assert!(ALLOWED_TOOLS.contains(&"glob"));
    assert!(ALLOWED_TOOLS.contains(&"write_file"));
    assert!(ALLOWED_TOOLS.contains(&"edit_file"));
    assert!(ALLOWED_TOOLS.contains(&"move_file"));
    assert!(ALLOWED_TOOLS.contains(&"delete_file"));
    // Shell execution is intentionally excluded from the browser bridge.
    assert!(!ALLOWED_TOOLS.contains(&"run_command"));
}

#[test]
fn max_propose_bytes_is_bounded() {
    const {
        assert!(MAX_PROPOSE_BYTES > 0);
        assert!(MAX_PROPOSE_BYTES <= 1_048_576); // 1 MiB cap
    };
}

#[test]
fn idempotency_ring_detects_duplicate_via_public_api() {
    let hub = browser_bridge::BrowserBridgeHub::default();
    let id = "req-1";
    assert!(!hub.is_duplicate(id), "fresh id must not be a duplicate");
    hub.record_id(id);
    assert!(hub.is_duplicate(id), "recorded id must be a duplicate");
    // A different id is not a duplicate.
    assert!(!hub.is_duplicate("req-2"));
}

#[test]
fn events_log_can_be_read() {
    let hub = browser_bridge::BrowserBridgeHub::default();
    // events() is public and returns a clone of the internal log
    let _events = hub.events();
}

// ---- request-lifecycle guarantees for the browser bridge --------------------
// The extension is an UNTRUSTED caller: it can be reloaded, disconnected,
// duplicated, or send garbage. These tests pin the backend's answers.

use neelima_lib::browser_bridge::{BridgeValidationError, ProposalValidationError};
use neelima_lib::ui::WorkspaceSlot;
use neelima_lib::workspace::Workspace;
use std::sync::Mutex;

fn proposal(version: u64, request_id: &str, tool: &str, args: serde_json::Value) -> String {
    serde_json::json!({
        "version": version,
        "operation": "tool.propose",
        "request_id": request_id,
        "proposal": { "tool": tool, "args": args, "site": "chatgpt" }
    })
    .to_string()
}

fn workspace_slot() -> (WorkspaceSlot, std::path::PathBuf) {
    let dir =
        std::env::temp_dir().join(format!("neelima-bridge-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    let ws = Workspace::open(&dir).unwrap();
    (WorkspaceSlot(Mutex::new(Some(ws))), dir)
}

#[test]
fn only_the_desktop_ui_may_submit_proposals() {
    let hub = browser_bridge::BrowserBridgeHub::default();
    let (slot, dir) = workspace_slot();
    let payload = proposal(
        1,
        "req-abc",
        "read_file",
        serde_json::json!({ "path": "a.txt" }),
    );
    // The provider webview (the website itself) must never reach this path.
    let err = browser_bridge::validate_browser_bridge_request(&hub, &slot, "provider", &payload)
        .unwrap_err();
    assert!(
        matches!(err, BridgeValidationError::InvalidWebview),
        "got {err}"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn malformed_and_oversized_payloads_are_refused_before_any_work() {
    let hub = browser_bridge::BrowserBridgeHub::default();
    let (slot, dir) = workspace_slot();
    let p_version = proposal(2, "req-1", "read_file", serde_json::json!({}));
    let p_tool = proposal(
        1,
        "req-2",
        "run_command",
        serde_json::json!({ "cmd": "dir" }),
    );
    let p_args = proposal(1, "req-3", "read_file", serde_json::json!("not-an-object"));
    let cases: Vec<(&str, fn(&BridgeValidationError) -> bool)> = vec![
        ("not json at all", |e| {
            matches!(e, BridgeValidationError::InvalidJson(_))
        }),
        ("[1,2,3]", |e| {
            matches!(e, BridgeValidationError::NotAnObject)
        }),
        (&p_version, |e| {
            matches!(e, BridgeValidationError::UnsupportedVersion)
        }),
        (&p_tool, |e| {
            matches!(e, BridgeValidationError::UnsupportedTool)
        }),
        (&p_args, |e| matches!(e, BridgeValidationError::InvalidArgs)),
    ];
    for (payload, want) in cases {
        let err = browser_bridge::validate_browser_bridge_request(&hub, &slot, "ui", payload)
            .unwrap_err();
        assert!(want(&err), "payload {payload} produced {err}");
    }
    let huge = "x".repeat(browser_bridge::MAX_PROPOSE_BYTES + 1);
    let err =
        browser_bridge::validate_browser_bridge_request(&hub, &slot, "ui", &huge).unwrap_err();
    assert!(matches!(err, BridgeValidationError::OversizedPayload));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn invalid_request_ids_are_rejected_so_correlation_cannot_be_forged() {
    let hub = browser_bridge::BrowserBridgeHub::default();
    let (slot, dir) = workspace_slot();
    for bad in [
        "",
        "has space",
        "../../etc/passwd",
        "id/with/slash",
        "id\nnewline",
    ] {
        let payload = proposal(1, bad, "read_file", serde_json::json!({ "path": "a.txt" }));
        let err = browser_bridge::validate_browser_bridge_request(&hub, &slot, "ui", &payload)
            .unwrap_err();
        assert!(
            matches!(err, BridgeValidationError::InvalidRequestId),
            "id {bad:?} produced {err}"
        );
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_proposal_requires_an_open_workspace() {
    let hub = browser_bridge::BrowserBridgeHub::default();
    let slot = WorkspaceSlot(Mutex::new(None));
    let payload = proposal(
        1,
        "req-nows",
        "read_file",
        serde_json::json!({ "path": "a.txt" }),
    );
    let err =
        browser_bridge::validate_browser_bridge_request(&hub, &slot, "ui", &payload).unwrap_err();
    assert!(
        matches!(err, BridgeValidationError::NoWorkspace),
        "got {err}"
    );
}

#[test]
fn replaying_the_same_transport_id_is_refused_not_re_executed() {
    let hub = browser_bridge::BrowserBridgeHub::default();
    let (slot, dir) = workspace_slot();
    let payload = proposal(
        1,
        "req-replay",
        "read_file",
        serde_json::json!({ "path": "a.txt" }),
    );
    assert!(browser_bridge::validate_browser_bridge_request(&hub, &slot, "ui", &payload).is_ok());
    let err =
        browser_bridge::validate_browser_bridge_request(&hub, &slot, "ui", &payload).unwrap_err();
    assert!(
        matches!(err, BridgeValidationError::Duplicate(_)),
        "got {err}"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_late_or_unknown_decision_is_dropped_without_delivery() {
    let hub = browser_bridge::BrowserBridgeHub::default();
    // A decision for a request the backend never saw (or already timed out).
    assert!(!hub.resolve_pending("never-seen", serde_json::json!({ "approved": true })));
    // A request abandoned on timeout must not accept a late decision.
    let (tx, rx) = tokio::sync::oneshot::channel();
    hub.register_pending("timed-out", tx);
    assert_eq!(hub.pending_count(), 1);
    hub.remove_pending("timed-out");
    assert_eq!(hub.pending_count(), 0);
    assert!(!hub.resolve_pending("timed-out", serde_json::json!({ "approved": true })));
    assert!(
        rx.blocking_recv().is_err(),
        "a dropped waiter never delivers"
    );
}

#[test]
fn a_decision_is_delivered_exactly_once() {
    let hub = browser_bridge::BrowserBridgeHub::default();
    let (tx, rx) = tokio::sync::oneshot::channel();
    hub.register_pending("req-once", tx);
    assert!(hub.resolve_pending("req-once", serde_json::json!({ "approved": true })));
    assert_eq!(
        rx.blocking_recv().unwrap()["approved"],
        serde_json::json!(true)
    );
    // A duplicate decision (double click, extension retry) has nobody to go to.
    assert!(!hub.resolve_pending("req-once", serde_json::json!({ "approved": false })));
    assert_eq!(hub.pending_count(), 0);
}

#[test]
fn proposal_validation_refuses_webpage_supplied_identity_and_bad_args() {
    let err = bridge_proposal(&serde_json::json!({
        "tool": "read_file",
        "args": { "path": "a.txt" },
        "workspace_id": "someone-elses"
    }))
    .unwrap_err();
    assert!(
        matches!(err, ProposalValidationError::ForbiddenTaskWorkspace),
        "got {err}"
    );
    // args must be an object; per-tool ARGUMENT typing is enforced later by the
    // tool executor against the workspace, not by this shape check.
    let err = bridge_proposal(&serde_json::json!({
        "tool": "delete_file",
        "args": "not-an-object"
    }))
    .unwrap_err();
    assert!(
        matches!(err, ProposalValidationError::InvalidArgs),
        "got {err}"
    );
}

fn bridge_proposal(
    value: &serde_json::Value,
) -> Result<browser_bridge::ValidatedProposalData, ProposalValidationError> {
    browser_bridge::validate_proposal(value.as_object().unwrap())
}
