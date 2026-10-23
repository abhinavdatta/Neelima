// Frontend contract tests: the pure provider-status reducer used by App.tsx.
// The TypeScript module is transformed with the project's own esbuild, so no
// extra test dependency is introduced.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { transformSync } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../src/providerStatus.ts"), "utf8");
const { code } = transformSync(source, { loader: "ts", format: "cjs" });
const mod = { exports: {} };
new Function("module", "exports", code)(mod, mod.exports);
const {
  reduceProviderRequestEvent,
  reduceStreamEvent,
  describePushRejection,
  providerStateLabel,
  failureCategoryLabel,
  isTerminalProviderState,
} = mod.exports;

const evt = (state, extra = {}) => ({ kind: "provider-request-state", state, ...extra });

test("lifecycle renders every contract state with a human label", () => {
  for (const state of [
    "created",
    "queued",
    "submitting",
    "submitted",
    "submission_unconfirmed",
    "streaming",
    "cancel_requested",
    "completed",
    "failed",
    "timed_out",
    "cancelled",
    "unknown",
  ]) {
    assert.ok(providerStateLabel(state).length > 0);
    assert.notEqual(providerStateLabel(state), "waiting", `${state} has a real label`);
  }
  assert.equal(providerStateLabel("nonsense"), "waiting");
});

test("a normal lifecycle ends in completed and clears the streaming preview", () => {
  let current = null;
  const states = ["created", "submitting", "submitted", "streaming"];
  for (const state of states) {
    const patch = reduceProviderRequestEvent(current, evt(state, { request_id: "r1", provider: "chatgpt" }));
    assert.ok(patch);
    assert.equal(patch.providerRequest.state, state);
    assert.equal(patch.providerRequest.requestId, "r1");
    assert.equal(patch.providerRequest.provider, "chatgpt");
    assert.equal(patch.clearStream, false, `${state} keeps the preview`);
    current = patch.providerRequest;
  }
  const completed = reduceProviderRequestEvent(current, evt("completed", { request_id: "r1" }));
  assert.equal(completed.providerRequest.state, "completed");
  assert.equal(completed.clearStream, true);
});

test("late transitions after a terminal state cannot repaint the UI", () => {
  let current = reduceProviderRequestEvent(null, evt("submitted", { request_id: "r1" })).providerRequest;
  current = reduceProviderRequestEvent(current, evt("timed_out", { request_id: "r1" })).providerRequest;
  for (const state of ["streaming", "completed", "failed", "cancelled"]) {
    const patch = reduceProviderRequestEvent(current, evt(state, { request_id: "r1" }));
    assert.equal(patch.providerRequest.state, "timed_out", `${state} must be ignored`);
    assert.equal(patch.clearStream, false);
  }
});

test("a new request ID begins a new lifecycle after a terminal state", () => {
  let current = reduceProviderRequestEvent(null, evt("cancelled", { request_id: "r1" })).providerRequest;
  const patch = reduceProviderRequestEvent(current, evt("created", { request_id: "r2" }));
  assert.equal(patch.providerRequest.state, "created");
  assert.equal(patch.providerRequest.requestId, "r2");
});

test("unknown or malformed states are ignored", () => {
  assert.equal(reduceProviderRequestEvent(null, evt("mystery")), null);
  assert.equal(reduceProviderRequestEvent(null, { kind: "provider-request-state" }), null);
  assert.equal(reduceProviderRequestEvent(null, null), null);
});

test("unconfirmed submission warns once, without page text", () => {
  const first = reduceProviderRequestEvent(null, evt("submission_unconfirmed", { request_id: "r1", text: "SECRET" }));
  assert.ok(first.toast);
  assert.equal(first.toast.level, "warn");
  assert.equal(JSON.stringify(first).includes("SECRET"), false, "reply/prompt text never enters status");
  const second = reduceProviderRequestEvent(first.providerRequest, evt("submission_unconfirmed", { request_id: "r1" }));
  assert.equal(second.toast, undefined, "the warning is emitted once per request");
});

test("failure categories are human-readable and terminal states are recognised", () => {
  assert.equal(failureCategoryLabel("login_required"), "sign-in required");
  assert.equal(failureCategoryLabel("page_unavailable"), "provider page unavailable");
  assert.equal(failureCategoryLabel("page_changed"), "provider page changed");
  assert.equal(failureCategoryLabel("send_failed"), "send failed");
  assert.equal(failureCategoryLabel("timeout"), "provider timeout");
  for (const terminal of ["completed", "failed", "timed_out", "cancelled"]) {
    assert.equal(isTerminalProviderState(terminal), true);
  }
  for (const live of ["created", "submitting", "submitted", "submission_unconfirmed", "streaming"]) {
    assert.equal(isTerminalProviderState(live), false);
  }
});

// ---- Step 2: local providers, cancel semantics, stream correlation ----

test("a local provider's lifecycle drives the same reducer as a web provider", () => {
  let current = null;
  for (const state of ["created", "submitting", "submitted", "streaming"]) {
    const patch = reduceProviderRequestEvent(current, evt(state, { request_id: "t1.abc", provider: "ollama", task_id: "t1" }));
    assert.ok(patch, `${state} applies for a local provider`);
    assert.equal(patch.providerRequest.provider, "ollama");
    current = patch.providerRequest;
  }
  const done = reduceProviderRequestEvent(current, evt("completed", { request_id: "t1.abc", provider: "ollama" }));
  assert.equal(done.providerRequest.state, "completed");
  assert.equal(done.clearStream, true);
});

test("cancel_requested is distinct from cancelled and is not terminal", () => {
  let current = reduceProviderRequestEvent(null, evt("streaming", { request_id: "r1" })).providerRequest;
  const requested = reduceProviderRequestEvent(current, evt("cancel_requested", { request_id: "r1" }));
  assert.equal(requested.providerRequest.state, "cancel_requested");
  assert.equal(requested.clearStream, true, "the preview stops at the cancel request");
  assert.equal(isTerminalProviderState("cancel_requested"), false, "a reply may still complete after a cancel");
  // The truthful completion-after-cancel still applies:
  const completed = reduceProviderRequestEvent(requested.providerRequest, evt("completed", { request_id: "r1" }));
  assert.equal(completed.providerRequest.state, "completed");
  // ...and the ordinary path reaches cancelled.
  const cancelled = reduceProviderRequestEvent(requested.providerRequest, evt("cancelled", { request_id: "r1" }));
  assert.equal(cancelled.providerRequest.state, "cancelled");
  assert.ok(isTerminalProviderState("cancelled"));
});

test("an unknown outcome is terminal, clears the preview and warns once", () => {
  let current = reduceProviderRequestEvent(null, evt("submitting", { request_id: "r1" })).providerRequest;
  const unknown = reduceProviderRequestEvent(current, evt("unknown", { request_id: "r1" }));
  assert.equal(unknown.providerRequest.state, "unknown");
  assert.equal(unknown.clearStream, true);
  assert.ok(unknown.toast, "the indeterminate outcome is stated once");
  assert.equal(JSON.stringify(unknown).includes("SECRET"), false);
  const again = reduceProviderRequestEvent(unknown.providerRequest, evt("unknown", { request_id: "r1" }));
  assert.equal(again.toast, undefined, "warned once per request");
  const late = reduceProviderRequestEvent(unknown.providerRequest, evt("completed", { request_id: "r1" }));
  assert.equal(late.providerRequest.state, "unknown", "a late event cannot repaint an unknown outcome");
});

test("stream chunks are correlated: append for deltas, replace for partials", () => {
  const current = reduceProviderRequestEvent(null, evt("streaming", { request_id: "t1.abc", provider: "ollama" })).providerRequest;
  const chunk = reduceStreamEvent(current, { text: "Hi", request_id: "t1.abc", provider: "ollama" }, "assistant-stream");
  assert.deepEqual(chunk, { text: "Hi", mode: "append" });
  const partial = reduceStreamEvent(current, { text: "accumulated tail", request_id: "t1.abc" }, "assistant-partial");
  assert.deepEqual(partial, { text: "accumulated tail", mode: "replace" });
});

test("late, foreign and post-cancel chunks are dropped at the frontend", () => {
  const current = reduceProviderRequestEvent(null, evt("streaming", { request_id: "r2", provider: "ollama" })).providerRequest;
  // Chunks from an earlier request can never pollute the current preview.
  assert.equal(reduceStreamEvent(current, { text: "stale", request_id: "r1" }, "assistant-stream"), null);
  // A different provider's chunk cannot land in this request.
  assert.equal(reduceStreamEvent(current, { text: "foreign", request_id: "r2", provider: "lmstudio" }, "assistant-stream"), null);
  // After a terminal state, nothing repaints.
  const done = reduceProviderRequestEvent(current, evt("timed_out", { request_id: "r2" })).providerRequest;
  assert.equal(reduceStreamEvent(done, { text: "late", request_id: "r2" }, "assistant-stream"), null);
  // After a cancel request, in-flight chunks are dropped too.
  const cancelling = reduceProviderRequestEvent(current, evt("cancel_requested", { request_id: "r2" })).providerRequest;
  assert.equal(reduceStreamEvent(cancelling, { text: "in-flight", request_id: "r2" }, "assistant-stream"), null);
  // Malformed events carry no usable text.
  assert.equal(reduceStreamEvent(current, { request_id: "r2" }, "assistant-stream"), null);
  assert.equal(reduceStreamEvent(null, null, "assistant-stream"), null);
});

test("failure categories cover local runtimes as well as web pages", () => {
  assert.equal(failureCategoryLabel("unavailable"), "local runtime unreachable");
  assert.equal(failureCategoryLabel("provider_error"), "provider error");
  assert.equal(failureCategoryLabel("config"), "provider not configured");
  assert.equal(failureCategoryLabel("closed"), "relay closed");
  assert.equal(failureCategoryLabel(undefined), "unknown");
});

test("push-rejection diagnostics carry the reason and never the dropped reply", () => {
  const note = describePushRejection({
    seq: 7,
    reason: "stale request (reply belongs to an earlier send)",
    text: "DROP ME",
  });
  assert.match(note, /#7/);
  assert.match(note, /stale request/);
  assert.equal(note.includes("DROP ME"), false);
});
