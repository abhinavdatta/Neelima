// CP8 pure helpers: persisted transcript -> bounded execution history.
import test from "node:test";
import assert from "node:assert/strict";
import {
  boundedExecutionOutput,
  collectExecutions,
  executionStatusLabel,
  executionStatusTone,
  formatExecutionDuration,
  formatExitCode,
  summarizeExecutions,
} from "../src/executionHistory.ts";

const call = (overrides = {}) => ({
  id: "c1",
  tool: "run_command",
  args: { command: "cargo test" },
  status: "ok",
  output: "2 passed",
  ...overrides,
});

const entry = (id, calls, kind = "tool_calls") => ({
  id,
  ts: 100 + id,
  kind,
  text: "",
  calls,
});

test("executions are flattened, deduped by entry/call and attributed to the task", () => {
  const entries = [
    entry(1, [call()]),
    entry(1, [call()]), // replayed entry: same id + call id
    entry(2, [call({ id: "c2", tool: "read_file", args: { path: "src/main.rs" } })]),
    entry(3, [], "assistant"),
  ];
  const items = collectExecutions(entries, {
    taskId: "task-1",
    taskTitle: "Tests",
    workspace: "C:/ws",
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].key, "1:c1");
  assert.equal(items[0].taskId, "task-1");
  assert.equal(items[0].taskTitle, "Tests");
  assert.equal(items[0].workspace, "C:/ws");
  assert.equal(items[1].path, "src/main.rs");
  assert.equal(items[0].output, "2 passed");
});

test("status labels and tones cover success, failure, timeout, cancel, rejection and refusal", () => {
  const cases = [
    ["ok", "succeeded", "ok"],
    ["error", "failed", "error"],
    ["timed_out", "timed out", "cancelled"],
    ["cancelled", "cancelled", "cancelled"],
    ["rejected", "rejected", "rejected"],
    ["refused", "refused", "rejected"],
    ["running", "running", "running"],
    ["weird", "weird", ""],
  ];
  for (const [status, label, tone] of cases) {
    assert.equal(executionStatusLabel(status), label);
    assert.equal(executionStatusTone(status), tone);
  }
  assert.equal(executionStatusLabel(""), "unknown");
});

test("the summary counts each terminal class and never hides other statuses", () => {
  const items = collectExecutions([
    entry(1, [
      call({ id: "a", status: "ok" }),
      call({ id: "b", status: "error" }),
      call({ id: "c", status: "timed_out" }),
      call({ id: "d", status: "cancelled" }),
      call({ id: "e", status: "rejected" }),
      call({ id: "f", status: "refused" }),
      call({ id: "g", status: "running" }),
    ]),
  ]);
  assert.deepEqual(summarizeExecutions(items), {
    total: 7,
    succeeded: 1,
    failed: 1,
    cancelled: 1,
    timedOut: 1,
    rejected: 1,
    refused: 1,
    other: 1,
  });
});

test("long output is bounded to the tail with an honest truncation marker", () => {
  const output = `${"a".repeat(20)}TAIL`;
  const bounded = boundedExecutionOutput(output, 10);
  assert.ok(bounded.startsWith("[output truncated; showing last 10 characters]"));
  assert.ok(bounded.endsWith("TAIL"));
  assert.ok(!bounded.includes("aaaaaaaaaaaaaaaaaaaa"));
});

test("missing and malformed calls do not become fake successes", () => {
  const entries = [
    entry(1, [null, {}, call({ id: "", status: undefined, tool: undefined })]),
    entry(2, "not-an-array"),
    { id: 3, kind: "tool_calls", calls: [call({ id: "real", status: "", output: "" })] },
    null,
  ];
  const items = collectExecutions(entries);
  assert.equal(items.length, 1, "only the call with an identity is rendered");
  assert.equal(items[0].callId, "real");
  assert.equal(items[0].tool, "run_command", "a named call keeps its real tool");
  assert.equal(items[0].status, "unknown", "an empty status is not rendered as success");
  assert.equal(items[0].output, "");
});

test("timestamps, duration and exit code are optional and formatted truthfully", () => {
  const items = collectExecutions(
    [entry(5, [call({ started_ms: 1000, duration_ms: 1250, exit_code: 7, action_id: "act-9" })])],
  );
  assert.equal(items[0].started_ms, 1000);
  assert.equal(items[0].duration_ms, 1250);
  assert.equal(items[0].exit_code, 7);
  assert.equal(items[0].action_id, "act-9");
  assert.equal(formatExecutionDuration(1250), "1.3 s");
  assert.equal(formatExecutionDuration(900), "900 ms");
  assert.equal(formatExecutionDuration(61_000), "1m 1s");
  assert.equal(formatExecutionDuration(null), "");
  assert.equal(formatExitCode(7), "exit 7");
  assert.equal(formatExitCode(null), "");
});

test("legacy records without CP8 metadata remain readable", () => {
  const legacy = { id: "old", tool: "read_file", args: { path: "a.txt" }, status: "ok", output: "body" };
  const items = collectExecutions([entry(9, [legacy])]);
  assert.equal(items.length, 1);
  assert.equal(items[0].started_ms, null);
  assert.equal(items[0].duration_ms, null);
  assert.equal(items[0].exit_code, null);
  assert.equal(items[0].action_id, null);
});
