//! Canonical, provider-independent request lifecycle (Step 2).
//!
//! One state machine shared by ALL provider kinds — browser web chats
//! (webprov), local inference runtimes (Ollama/LM Studio, providers.rs) and
//! the manual relay. The registry is the single place that:
//!
//! - validates every state transition (an invalid transition is dropped, not
//!   emitted, so backend and frontend can never disagree about the contract),
//! - guarantees at most ONE terminal outcome per request (a late partial, a
//!   racing error path or a duplicate event cannot resurrect or double-finish
//!   a request),
//! - keeps a bounded, metadata-only record of recent requests so diagnostics
//!   can answer "what happened to the last N requests across all providers"
//!   without ever storing prompt or reply text.
//!
//! Request identity is separate from provider identity, conversation identity
//! and agent-task identity: a `request_id` is minted per provider send, never
//! reused, and every response update is correlated to it (plus provider and,
//! where available, conversation/task identity).

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

/// Lifecycle states. Not every provider uses every state: browser providers
/// can report `submission_unconfirmed`; local runtimes always confirm their
/// POST synchronously (or fail it); the manual relay has no submission stage
/// beyond handing the prompt to the user.
pub const REQUEST_CREATED: &str = "created";
pub const REQUEST_QUEUED: &str = "queued";
pub const REQUEST_SUBMITTING: &str = "submitting";
pub const REQUEST_SUBMITTED: &str = "submitted";
pub const REQUEST_SUBMISSION_UNCONFIRMED: &str = "submission_unconfirmed";
pub const REQUEST_STREAMING: &str = "streaming";
pub const REQUEST_CANCEL_REQUESTED: &str = "cancel_requested";
pub const REQUEST_COMPLETED: &str = "completed";
pub const REQUEST_FAILED: &str = "failed";
pub const REQUEST_TIMED_OUT: &str = "timed_out";
pub const REQUEST_CANCELLED: &str = "cancelled";
/// Reserved terminal state for a genuinely indeterminate outcome (the app can
/// prove neither completion nor any specific failure). Kept in the model so an
/// honest "we don't know" is representable instead of being forced into a
/// wrong specific state.
pub const REQUEST_UNKNOWN: &str = "unknown";

/// Terminal states: recorded at most once per request; nothing follows them.
pub fn is_terminal_request_state(next: &str) -> bool {
    matches!(
        next,
        REQUEST_COMPLETED
            | REQUEST_FAILED
            | REQUEST_TIMED_OUT
            | REQUEST_CANCELLED
            | REQUEST_UNKNOWN
    )
}

pub fn is_valid_request_state(s: &str) -> bool {
    matches!(
        s,
        REQUEST_CREATED
            | REQUEST_QUEUED
            | REQUEST_SUBMITTING
            | REQUEST_SUBMITTED
            | REQUEST_SUBMISSION_UNCONFIRMED
            | REQUEST_STREAMING
            | REQUEST_CANCEL_REQUESTED
            | REQUEST_COMPLETED
            | REQUEST_FAILED
            | REQUEST_TIMED_OUT
            | REQUEST_CANCELLED
            | REQUEST_UNKNOWN
    )
}

/// Transition table (C1). Anything not listed is rejected — including every
/// transition out of a terminal state (C2/C3) and any move "backwards"
/// (e.g. streaming → submitted).
///
/// Notes on individual edges:
/// - `cancel_requested → completed` is allowed ONCE, deliberately: if a reply
///   lands despite a cancel, the truthful outcome is completion, not
///   cancellation. `cancel_requested → timed_out` likewise covers a cancel
///   request that raced the deadline.
/// - `streaming → streaming` is allowed: providers may report streaming
///   updates repeatedly; the registry de-duplicates nothing but the terminal.
pub fn transition_allowed(from: &str, to: &str) -> bool {
    if is_terminal_request_state(from) {
        return false;
    }
    match from {
        REQUEST_CREATED => matches!(
            to,
            REQUEST_SUBMITTING
                | REQUEST_SUBMITTED
                | REQUEST_SUBMISSION_UNCONFIRMED
                | REQUEST_STREAMING
                | REQUEST_CANCEL_REQUESTED
                | REQUEST_COMPLETED
                | REQUEST_FAILED
                | REQUEST_TIMED_OUT
                | REQUEST_CANCELLED
                | REQUEST_UNKNOWN
        ),
        REQUEST_QUEUED => matches!(
            to,
            REQUEST_SUBMITTING
                | REQUEST_CANCEL_REQUESTED
                | REQUEST_FAILED
                | REQUEST_TIMED_OUT
                | REQUEST_CANCELLED
                | REQUEST_UNKNOWN
        ),
        REQUEST_SUBMITTING => matches!(
            to,
            REQUEST_SUBMITTED
                | REQUEST_SUBMISSION_UNCONFIRMED
                | REQUEST_STREAMING
                | REQUEST_COMPLETED
                | REQUEST_CANCEL_REQUESTED
                | REQUEST_FAILED
                | REQUEST_TIMED_OUT
                | REQUEST_CANCELLED
                | REQUEST_UNKNOWN
        ),
        REQUEST_SUBMITTED => matches!(
            to,
            REQUEST_STREAMING
                | REQUEST_COMPLETED
                | REQUEST_CANCEL_REQUESTED
                | REQUEST_FAILED
                | REQUEST_TIMED_OUT
                | REQUEST_CANCELLED
                | REQUEST_UNKNOWN
        ),
        REQUEST_SUBMISSION_UNCONFIRMED => matches!(
            to,
            REQUEST_STREAMING
                | REQUEST_COMPLETED
                | REQUEST_FAILED
                | REQUEST_TIMED_OUT
                | REQUEST_CANCELLED
                | REQUEST_UNKNOWN
        ),
        REQUEST_STREAMING => matches!(
            to,
            REQUEST_STREAMING
                | REQUEST_COMPLETED
                | REQUEST_CANCEL_REQUESTED
                | REQUEST_FAILED
                | REQUEST_TIMED_OUT
                | REQUEST_CANCELLED
                | REQUEST_UNKNOWN
        ),
        REQUEST_CANCEL_REQUESTED => matches!(
            to,
            REQUEST_CANCELLED
                | REQUEST_COMPLETED
                | REQUEST_FAILED
                | REQUEST_TIMED_OUT
                | REQUEST_UNKNOWN
        ),
        _ => false,
    }
}

/// Legacy per-request guard used by the Step-1 webprov tests: keeps one
/// `terminal` marker per request ID. The registry below supersedes it for all
/// providers; kept because its semantics (a DIFFERENT request ID starts a
/// fresh lifecycle) are still the documented contract.
pub fn allow_request_state(terminal: &mut Option<String>, request_id: &str, next: &str) -> bool {
    if terminal.as_deref() == Some(request_id) {
        return false;
    }
    if terminal.is_some() && !is_terminal_request_state(next) {
        *terminal = None;
    }
    if is_terminal_request_state(next) {
        *terminal = Some(request_id.to_string());
    }
    true
}

/// Terminal state for an unsuccessful reply wait: a user cancel reports
/// `cancelled`, everything else ran out the clock (`timed_out`). Shared by
/// web and local providers so the distinction is identical everywhere.
pub fn reply_wait_state(error: &str) -> &'static str {
    if error == "stopped" {
        REQUEST_CANCELLED
    } else {
        REQUEST_TIMED_OUT
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// One tracked request. Contains METADATA ONLY by construction: there is no
/// field anywhere in this struct that can hold prompt or reply text.
#[derive(Debug, Clone, PartialEq)]
pub struct RequestRecord {
    pub request_id: String,
    pub provider_id: String,
    pub task_id: Option<String>,
    pub conversation_id: Option<String>,
    pub status: String,
    pub error_category: Option<String>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

impl RequestRecord {
    fn new(
        request_id: &str,
        provider_id: &str,
        task_id: Option<&str>,
        conversation_id: Option<&str>,
    ) -> Self {
        let now = now_ms();
        RequestRecord {
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
            task_id: task_id.map(str::to_owned),
            conversation_id: conversation_id.map(str::to_owned),
            status: REQUEST_CREATED.to_string(),
            error_category: None,
            created_at_ms: now,
            updated_at_ms: now,
        }
    }
}

/// Bounded registry of recent requests (metadata only). Thread-safe; shared
/// by all provider implementations and the diagnostics command.
#[derive(Default)]
pub struct RequestRegistry {
    records: Mutex<VecDeque<RequestRecord>>,
}

/// Keep the last N requests for diagnostics; older ones fall off. Requests
/// are per provider-send, so this covers a long session's recent activity.
const REGISTRY_LIMIT: usize = 64;

impl RequestRegistry {
    /// Register a new request in state `created`. Returns false when the ID
    /// was already used — an ID is never reused for a new request (B).
    pub fn begin(
        &self,
        request_id: &str,
        provider_id: &str,
        task_id: Option<&str>,
        conversation_id: Option<&str>,
    ) -> bool {
        let mut records = self.records.lock().unwrap();
        if records.iter().any(|r| r.request_id == request_id) {
            return false;
        }
        records.push_back(RequestRecord::new(
            request_id,
            provider_id,
            task_id,
            conversation_id,
        ));
        while records.len() > REGISTRY_LIMIT {
            records.pop_front();
        }
        true
    }

    /// Apply one validated transition. Returns the updated record when the
    /// transition was applied; None when it was REJECTED — unknown request,
    /// unknown state string, or an edge the state machine forbids (including
    /// anything after a terminal state). Rejected transitions change nothing.
    pub fn transition(
        &self,
        request_id: &str,
        next: &str,
        category: Option<&str>,
    ) -> Option<RequestRecord> {
        if !is_valid_request_state(next) {
            return None;
        }
        let mut records = self.records.lock().unwrap();
        let record = records.iter_mut().find(|r| r.request_id == request_id)?;
        if !transition_allowed(&record.status, next) {
            return None;
        }
        record.status = next.to_string();
        record.updated_at_ms = now_ms();
        if let Some(category) = category {
            record.error_category = Some(category.to_string());
        }
        Some(record.clone())
    }

    pub fn status_of(&self, request_id: &str) -> Option<String> {
        self.records
            .lock()
            .unwrap()
            .iter()
            .find(|r| r.request_id == request_id)
            .map(|r| r.status.clone())
    }

    /// Whether the request exists and has NOT reached a terminal state. Used
    /// to gate late streaming chunks (E): a chunk for a request that is not
    /// live is dropped at the source instead of polluting a newer request.
    pub fn is_live(&self, request_id: &str) -> bool {
        self.records
            .lock()
            .unwrap()
            .iter()
            .find(|r| r.request_id == request_id)
            .map(|r| !is_terminal_request_state(&r.status))
            .unwrap_or(false)
    }

    /// Whether streaming chunks may still be delivered for this request.
    /// True only while the request is actively awaiting/receiving a reply —
    /// AFTER a cancel request or any terminal state, late in-flight chunks
    /// are dropped at the source instead of polluting a newer request's
    /// preview (D7).
    pub fn is_streaming_allowed(&self, request_id: &str) -> bool {
        self.records
            .lock()
            .unwrap()
            .iter()
            .find(|r| r.request_id == request_id)
            .map(|r| {
                matches!(
                    r.status.as_str(),
                    REQUEST_CREATED
                        | REQUEST_QUEUED
                        | REQUEST_SUBMITTING
                        | REQUEST_SUBMITTED
                        | REQUEST_SUBMISSION_UNCONFIRMED
                        | REQUEST_STREAMING
                )
            })
            .unwrap_or(false)
    }

    /// Strongest available correlation for a task round: the most recent
    /// NON-terminal request belonging to `task_id`. None when the task has no
    /// live request (finished, cancelled, or never sent).
    pub fn live_for_task(&self, task_id: &str) -> Option<String> {
        self.records
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|r| {
                r.task_id.as_deref() == Some(task_id) && !is_terminal_request_state(&r.status)
            })
            .map(|r| r.request_id.clone())
    }

    /// Correlation for records written AFTER a request has already completed
    /// (e.g. action-ledger entries for tool calls executed once a reply
    /// landed): the most recent request for `task_id` regardless of liveness.
    /// Unlike [`Self::live_for_task`] this never reports liveness, so callers
    /// must not use it to gate delivery.
    pub fn latest_for_task(&self, task_id: &str) -> Option<String> {
        self.records
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|r| r.task_id.as_deref() == Some(task_id))
            .map(|r| r.request_id.clone())
    }

    /// Metadata-only snapshot, oldest → newest, for diagnostics.
    pub fn snapshot(&self) -> Vec<Value> {
        self.records
            .lock()
            .unwrap()
            .iter()
            .map(|r| {
                let mut v = json!({
                    "request_id": r.request_id,
                    "provider_id": r.provider_id,
                    "status": r.status,
                    "created_at_ms": r.created_at_ms,
                    "updated_at_ms": r.updated_at_ms,
                });
                if let Some(task_id) = &r.task_id {
                    v["task_id"] = json!(task_id);
                }
                if let Some(conversation_id) = &r.conversation_id {
                    v["conversation_id"] = json!(conversation_id);
                }
                if let Some(category) = &r.error_category {
                    v["error_category"] = json!(category);
                }
                v["duration_ms"] = json!(r.updated_at_ms.saturating_sub(r.created_at_ms));
                v
            })
            .collect()
    }
}

/// The `provider-request-state` event payload. Metadata only: identity,
/// state, timing and (coarse, non-sensitive) failure category — never prompt
/// or reply content.
pub fn request_event_payload(record: &RequestRecord, category: Option<&str>) -> Value {
    let mut payload = json!({
        "kind": "provider-request-state",
        "request_id": record.request_id,
        "provider": record.provider_id,
        "state": record.status,
        "at_ms": record.updated_at_ms,
        "created_at_ms": record.created_at_ms,
    });
    if let Some(task_id) = &record.task_id {
        payload["task_id"] = json!(task_id);
    }
    if let Some(conversation_id) = &record.conversation_id {
        payload["conversation_id"] = json!(conversation_id);
    }
    if let Some(category) = category.or(record.error_category.as_deref()) {
        payload["error_category"] = json!(category);
    }
    payload
}

// ---------------------------------------------------------------------------
// App-facing helpers (used by webprov / providers / manual relay)
// ---------------------------------------------------------------------------

pub fn registry_of(app: &tauri::AppHandle) -> Arc<RequestRegistry> {
    use tauri::Manager;
    app.state::<Arc<RequestRegistry>>().inner().clone()
}

/// Register a request in the shared registry and emit its `created` event.
/// Returns false when the ID was already used (event suppressed too).
pub fn begin_and_emit(
    app: &tauri::AppHandle,
    request_id: &str,
    provider_id: &str,
    task_id: Option<&str>,
    conversation_id: Option<&str>,
) -> bool {
    let registry = registry_of(app);
    if !registry.begin(request_id, provider_id, task_id, conversation_id) {
        return false;
    }
    if let Some(record) = registry.snapshot_record(request_id) {
        use tauri::Emitter;
        let _ = app.emit("evt", request_event_payload(&record, None));
    }
    true
}

/// Apply a validated transition in the shared registry and emit the matching
/// `provider-request-state` event. Returns false when the transition was
/// rejected (nothing emitted, nothing recorded).
pub fn transition_and_emit(
    app: &tauri::AppHandle,
    request_id: &str,
    next: &str,
    category: Option<&str>,
) -> bool {
    let registry = registry_of(app);
    match registry.transition(request_id, next, category) {
        Some(record) => {
            use tauri::Emitter;
            let _ = app.emit("evt", request_event_payload(&record, category));
            true
        }
        None => false,
    }
}

impl RequestRegistry {
    /// Internal helper for the emit path: fetch one record by ID.
    pub(crate) fn snapshot_record(&self, request_id: &str) -> Option<RequestRecord> {
        self.records
            .lock()
            .unwrap()
            .iter()
            .find(|r| r.request_id == request_id)
            .cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> Arc<RequestRegistry> {
        Arc::new(RequestRegistry::default())
    }

    /// J1: request IDs are never reused; a duplicate `begin` is refused.
    #[test]
    fn request_ids_are_unique_and_never_reused() {
        let reg = registry();
        assert!(reg.begin("t1.aaaa", "ollama", Some("t1"), None));
        assert!(
            !reg.begin("t1.aaaa", "ollama", Some("t1"), None),
            "the same ID must never be registered twice"
        );
        assert!(reg.begin("t1.bbbb", "ollama", Some("t1"), None));
        assert_eq!(reg.status_of("t1.aaaa").as_deref(), Some(REQUEST_CREATED));
    }

    /// J2: the full happy path for a streaming provider (local or web).
    #[test]
    fn valid_lifecycle_transitions_apply_in_order() {
        let reg = registry();
        assert!(reg.begin("r1", "ollama", Some("t1"), None));
        for state in [
            REQUEST_SUBMITTING,
            REQUEST_SUBMITTED,
            REQUEST_STREAMING,
            REQUEST_STREAMING,
            REQUEST_COMPLETED,
        ] {
            assert!(
                reg.transition("r1", state, None).is_some(),
                "{state} must be allowed"
            );
        }
        assert_eq!(reg.status_of("r1").as_deref(), Some(REQUEST_COMPLETED));
    }

    /// J2 (negative): invalid edges are rejected and change nothing.
    #[test]
    fn invalid_transitions_are_rejected_and_leave_state_unchanged() {
        let reg = registry();
        assert!(reg.begin("r1", "lmstudio", Some("t1"), None));
        reg.transition("r1", REQUEST_SUBMITTING, None).unwrap();
        for bad in [
            REQUEST_CREATED, // cannot be re-created
            REQUEST_QUEUED,  // no backwards move
            // submitting → submitted, then submission_unconfirmed would be a
            // backwards move too (covered below).
            "nonsense", // not a state at all
        ] {
            assert!(
                reg.transition("r1", bad, None).is_none(),
                "{bad} must be rejected"
            );
            assert_eq!(
                reg.status_of("r1").as_deref(),
                Some(REQUEST_SUBMITTING),
                "rejected transition must not change state"
            );
        }
        // The web provider's honest-uncertainty path IS valid: submitting →
        // submission_unconfirmed (the prompt may or may not have landed).
        assert!(reg
            .transition("r1", REQUEST_SUBMISSION_UNCONFIRMED, None)
            .is_some());
    }

    /// J7: exactly one terminal outcome; duplicates and late events are
    /// suppressed and the record keeps its final state.
    #[test]
    fn duplicate_terminal_and_late_events_are_suppressed() {
        let reg = registry();
        assert!(reg.begin("r1", "claude", Some("t1"), Some("conv")));
        reg.transition("r1", REQUEST_SUBMITTING, None).unwrap();
        reg.transition("r1", REQUEST_STREAMING, None).unwrap();
        reg.transition("r1", REQUEST_TIMED_OUT, Some("timeout"))
            .unwrap();
        for late in [
            (REQUEST_STREAMING, None),
            (REQUEST_COMPLETED, None),
            (REQUEST_TIMED_OUT, None),
            (REQUEST_CANCELLED, None),
        ] {
            assert!(
                reg.transition("r1", late.0, late.1).is_none(),
                "{late:?} after the terminal state must be suppressed"
            );
        }
        let record = reg.snapshot_record("r1").unwrap();
        assert_eq!(record.status, REQUEST_TIMED_OUT);
        assert_eq!(record.error_category.as_deref(), Some("timeout"));
    }

    /// J9: transitions for a request the registry never saw are rejected —
    /// a response for a nonexistent request can never create state.
    #[test]
    fn transitions_for_unknown_requests_are_rejected() {
        let reg = registry();
        assert!(reg.transition("ghost", REQUEST_COMPLETED, None).is_none());
        assert!(!reg.is_live("ghost"));
        assert_eq!(reg.status_of("ghost"), None);
    }

    /// Phase A: action-ledger correlation needs the most recent request for a
    /// task even after it reached a terminal state (tools usually execute
    /// after the reply completed the request). Unlike `live_for_task`, this
    /// never reports liveness.
    #[test]
    fn latest_for_task_returns_terminal_requests_too() {
        let reg = registry();
        assert_eq!(reg.latest_for_task("t"), None, "unknown task");
        assert!(reg.begin("t.aaaa", "ollama", Some("t"), None));
        reg.transition("t.aaaa", REQUEST_SUBMITTING, None).unwrap();
        reg.transition("t.aaaa", REQUEST_COMPLETED, None).unwrap();
        // live_for_task correctly reports nothing once terminal…
        assert_eq!(reg.live_for_task("t"), None);
        // …while latest_for_task still correlates for record-keeping.
        assert_eq!(reg.latest_for_task("t").as_deref(), Some("t.aaaa"));
        // A newer request for the same task wins.
        assert!(reg.begin("t.bbbb", "ollama", Some("t"), None));
        assert_eq!(reg.latest_for_task("t").as_deref(), Some("t.bbbb"));
        // Other tasks are invisible.
        assert!(reg.begin("x.1", "ollama", Some("x"), None));
        assert_eq!(reg.latest_for_task("t").as_deref(), Some("t.bbbb"));
    }

    /// E/F: liveness gating and per-task correlation.
    #[test]
    fn liveness_and_task_correlation_isolate_requests() {
        let reg = registry();
        assert!(reg.begin("a.1", "ollama", Some("a"), None));
        assert!(reg.begin("b.1", "claude", Some("b"), Some("conv-b")));
        reg.transition("a.1", REQUEST_SUBMITTING, None).unwrap();
        assert_eq!(reg.live_for_task("a").as_deref(), Some("a.1"));
        // The other task's request is not visible through task a.
        assert!(reg.live_for_task("a").as_deref() != Some("b.1"));
        reg.transition("a.1", REQUEST_COMPLETED, None).unwrap();
        assert_eq!(
            reg.live_for_task("a"),
            None,
            "a finished task has no live request"
        );
        // b's request is unaffected by a's completion (isolation).
        assert!(reg.is_live("b.1"));
    }

    /// C5: cancel requested ≠ cancelled, and a reply that lands despite the
    /// cancel is reported truthfully as completed.
    #[test]
    fn cancel_requested_is_distinct_and_completion_despite_cancel_is_truthful() {
        let reg = registry();
        assert!(reg.begin("r1", "ollama", Some("t1"), None));
        reg.transition("r1", REQUEST_SUBMITTING, None).unwrap();
        reg.transition("r1", REQUEST_STREAMING, None).unwrap();
        reg.transition("r1", REQUEST_CANCEL_REQUESTED, None)
            .unwrap();
        assert!(
            reg.is_live("r1"),
            "cancel_requested is not terminal: still in flight"
        );
        assert!(reg.transition("r1", REQUEST_COMPLETED, None).is_some());
        // ...while the ordinary path cancels:
        assert!(reg.begin("r2", "ollama", Some("t1"), None));
        reg.transition("r2", REQUEST_CANCEL_REQUESTED, None)
            .unwrap();
        assert!(reg.transition("r2", REQUEST_CANCELLED, None).is_some());
        assert!(reg
            .transition("r2", REQUEST_CANCEL_REQUESTED, None)
            .is_none());
    }

    /// I: the snapshot is bounded and carries metadata only.
    #[test]
    fn snapshot_is_bounded_and_metadata_only() {
        let reg = registry();
        for i in 0..(REGISTRY_LIMIT + 10) {
            let id = format!("r{i}");
            assert!(reg.begin(&id, "ollama", Some("t"), None));
            reg.transition(&id, REQUEST_COMPLETED, None).unwrap();
        }
        let snapshot = reg.snapshot();
        assert_eq!(snapshot.len(), REGISTRY_LIMIT, "bounded");
        // Oldest dropped, newest retained.
        assert!(snapshot.iter().any(|v| v["request_id"] == "r73"));
        assert!(!snapshot.iter().any(|v| v["request_id"] == "r0"));
        for record in &snapshot {
            let obj = record.as_object().unwrap();
            for key in obj.keys() {
                assert!(
                    !key.contains("text") && !key.contains("prompt") && !key.contains("content"),
                    "snapshot must be metadata-only, found key {key}"
                );
            }
            assert!(obj.contains_key("duration_ms"));
        }
    }

    /// Payload shape: identity + state + timing + category, never text.
    #[test]
    fn event_payload_is_metadata_only() {
        let reg = registry();
        assert!(reg.begin("r1", "web:ChatGPT", Some("t1"), Some("conv1")));
        let record = reg
            .transition("r1", REQUEST_FAILED, Some("send_failed"))
            .unwrap();
        let payload = request_event_payload(&record, Some("send_failed"));
        assert_eq!(payload["kind"], "provider-request-state");
        assert_eq!(payload["request_id"], "r1");
        assert_eq!(payload["provider"], "web:ChatGPT");
        assert_eq!(payload["state"], "failed");
        assert_eq!(payload["task_id"], "t1");
        assert_eq!(payload["conversation_id"], "conv1");
        assert_eq!(payload["error_category"], "send_failed");
        assert!(payload.get("text").is_none());
        assert!(payload.get("output").is_none());
    }
}
