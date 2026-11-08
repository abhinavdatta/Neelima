// Checkpoint 7 — pure terminal helpers. The Rust PTY lifecycle is covered by
// terminal::tests in src-tauri/src/terminal.rs; these tests cover the
// pre-session event buffer, status/exit presentation and workspace labels
// without requiring xterm or a Tauri runtime.
import test from "node:test";
import assert from "node:assert/strict";
import {
  bufferTerminalEvent,
  terminalExitText,
  terminalStatusText,
  terminalWorkspaceName,
  TERMINAL_PENDING_LIMIT,
} from "../src/terminal.ts";

test("pre-session events are kept in order and bounded by bytes", () => {
  const first = { kind: "term-data", session: 1, data: "a".repeat(60) };
  const second = { kind: "term-data", session: 1, data: "b".repeat(60) };
  let queue = [first];
  queue = bufferTerminalEvent(queue, second, 100);
  assert.deepEqual(queue, [second], "the oldest chunk is dropped first");
  assert.equal(queue.reduce((n, e) => n + (e.kind === "term-data" ? e.data.length : 0), 0), 60);
});

test("the pre-session bound counts UTF-8 bytes, not UTF-16 units", () => {
  // "😀" is 2 UTF-16 code units but 4 UTF-8 bytes. Four of them plus "aaaa"
  // are 12 units but 20 bytes, so only the byte bound evicts the old chunk.
  const prefix = { kind: "term-data", session: 4, data: "aaaa" };
  const emoji = { kind: "term-data", session: 4, data: "😀".repeat(4) };
  const queue = bufferTerminalEvent([prefix], emoji, 16);
  assert.deepEqual(queue, [emoji], "the old chunk is evicted by the byte bound");
});

test("an exit event survives buffering and the input queue is untouched", () => {
  const first = { kind: "term-data", session: 2, data: "x".repeat(80) };
  const original = [first];
  const second = { kind: "term-exit", session: 2, code: 3 };
  const queue = bufferTerminalEvent(original, second, 50);
  assert.deepEqual(original, [first], "the caller's array is not mutated");
  assert.deepEqual(queue, [second], "the zero-byte exit is never discarded for data");
});

test("late data cannot evict an exit event that arrived first", () => {
  const exit = { kind: "term-exit", session: 5, code: null };
  const data = { kind: "term-data", session: 5, data: "y".repeat(80) };
  const queue = bufferTerminalEvent([exit], data, 50);
  assert.deepEqual(queue, [exit], "the exit status survives and bounded data is dropped");
});

test("a single oversized chunk is kept rather than producing an empty queue", () => {
  // One event larger than the bound must survive on its own: dropping the only
  // event would silently lose the prompt. The panel writes it immediately once
  // the PTY id is known, so this is a one-event overshoot, not an unbounded
  // queue.
  const event = { kind: "term-data", session: 3, data: "z".repeat(TERMINAL_PENDING_LIMIT + 1) };
  assert.deepEqual(bufferTerminalEvent([], event), [event]);
});

test("exit text reports the real code and never invents one", () => {
  assert.match(terminalExitText(7), /\[terminal process exited \(code 7\)\]/);
  assert.match(terminalExitText(0), /\(code 0\)/);
  assert.match(terminalExitText(null), /\[terminal process exited\]/);
  assert.doesNotMatch(terminalExitText(null), /code/);
});

test("workspace labels use the final path component on both platforms", () => {
  assert.equal(terminalWorkspaceName("C:\\Users\\dev\\inamigos webdev"), "inamigos webdev");
  assert.equal(terminalWorkspaceName("/home/dev/project"), "project");
  assert.equal(terminalWorkspaceName(null), "workspace");
  assert.equal(terminalWorkspaceName("C:\\"), "C:");
});

test("status text distinguishes no-workspace, connecting, live, exited and failure", () => {
  assert.equal(terminalStatusText({ kind: "noworkspace" }), "No workspace");
  assert.equal(terminalStatusText({ kind: "connecting" }), "Starting…");
  assert.equal(terminalStatusText({ kind: "running" }), "Live");
  assert.equal(terminalStatusText({ kind: "exited", code: 0 }), "Exited (0)");
  assert.equal(terminalStatusText({ kind: "exited", code: null }), "Exited");
  assert.equal(terminalStatusText({ kind: "error", message: "no pty" }), "Failed");
});
