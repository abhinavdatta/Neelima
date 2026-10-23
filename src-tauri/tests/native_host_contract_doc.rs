//! Documentation-drift guard for the native-host contract.
//!
//! `browser-extension/docs/NATIVE-HOST-PROTOCOL.md` separates the intended
//! contract from the implementation status. These tests pin the numbers and
//! claims in the implementation-status section to the constants the code
//! actually enforces, so the document cannot silently go stale again (the
//! same lockstep idea as `acl_coverage.rs`, applied to the contract doc).

use neelima_lib::browser_bridge::{APPROVAL_TIMEOUT, IDEMPOTENCY_RING, MAX_PROPOSE_BYTES};

fn contract_doc() -> String {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../browser-extension/docs/NATIVE-HOST-PROTOCOL.md"
    );
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("contract doc readable at {path}: {e}"))
}

#[test]
fn implemented_section_states_the_real_frame_limit() {
    // MAX_PROPOSE_BYTES / NATIVE_HOST_MAX_BYTES / MAX_MESSAGE_BYTES — 256 KiB.
    let limit = format!("{}", MAX_PROPOSE_BYTES);
    assert!(
        contract_doc().contains(&limit),
        "the doc must state the actual frame limit of {limit} bytes"
    );
}

#[test]
fn implemented_section_states_the_real_approval_window() {
    let secs = APPROVAL_TIMEOUT.as_secs().to_string();
    assert!(
        contract_doc().contains(&format!("{secs} s")),
        "the doc must state the actual approval window of {secs} s"
    );
}

#[test]
fn implemented_section_states_the_real_idempotency_ring() {
    assert!(
        contract_doc().contains(&format!("{}-entry", IDEMPOTENCY_RING)),
        "the doc must state the actual {}-entry idempotency ring",
        IDEMPOTENCY_RING
    );
    assert!(
        contract_doc().contains("not durable"),
        "the doc must keep the not-durable-across-restarts limitation explicit"
    );
}

#[test]
fn the_approval_id_round_trip_is_marked_not_implemented() {
    let doc = contract_doc();
    assert!(
        doc.contains("approval_id"),
        "the illustrative sketch is kept"
    );
    assert!(
        doc.contains("not implemented"),
        "the sketch must be explicitly marked as not implemented"
    );
    assert!(
        doc.contains("carries the **real final decision**"),
        "the doc must state that the propose reply carries the real decision"
    );
}

#[test]
fn reserved_operations_stay_marked_unsupported() {
    let doc = contract_doc();
    assert!(
        doc.to_lowercase().contains("reserved and unsupported"),
        "workspace.list / task.status / task.cancel must stay marked reserved"
    );
    assert!(
        doc.contains("bridge.capabilities"),
        "the doc must document the implemented capabilities operation"
    );
}

#[test]
fn implemented_section_lists_the_real_error_codes() {
    let doc = contract_doc();
    for code in [
        "INVALID_JSON",
        "UNSUPPORTED_VERSION",
        "UNSUPPORTED_OPERATION",
        "INVALID_PROPOSAL",
        "FORBIDDEN",
        "UNSUPPORTED_TOOL",
        "INVALID_ARGS",
        "NO_WORKSPACE",
        "SERVER_ERROR",
        "IPC_ERROR",
    ] {
        assert!(
            doc.contains(code),
            "the doc must list the real error code {code}"
        );
    }
}

/// Phase B: the doc must describe the unified, mode-dependent approval policy
/// (reads ask in ask_all; same mapping as the agent route).
#[test]
fn implemented_section_states_the_unified_approval_policy() {
    let doc = contract_doc();
    assert!(
        doc.contains("approval_policy"),
        "the doc must reference the machine-readable approval_policy field"
    );
    assert!(
        doc.contains("risk-based mapping") || doc.contains("risk-based\nmapping"),
        "the doc must state the bridge uses the same risk-based mapping as the agent route"
    );
}
