// Guards for the approval-card lifecycle rules (ui/src/approvalLifecycle.ts).
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { transformSync } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../src/approvalLifecycle.ts"), "utf8");
// esbuild strips TS types; the pure module has no imports, so plain CommonJS.
const stripped = transformSync(source, { loader: "ts", format: "cjs", legalComments: "none" }).code;
const mod = { exports: {} };
new Function("module", "exports", stripped)(mod, mod.exports);
const { pruneApprovalCards, classifyApprovalElement, shouldAcceptApprovalEvent } = mod.exports;

const liveTask = (over = {}) => ({
  taskId: "t1",
  agentState: "executing",
  pendingCalls: [{ id: "req-1" }],
  bridgeApproval: null,
  ...over,
});

function makeDom() {
  const removed = [];
  const el = (text) => ({ textContent: text, remove: () => removed.push(text) });
  return { el, removed };
}

test("an approval card for the active task with a live pending call stays", () => {
  const cred = classifyApprovalElement(["approval-head", "approval-card"], {
    textContent: "Approval required — 1 tool call(s)",
  }, liveTask());
  assert.equal(cred, "approval");
});

test("a card stays while the agent awaits approval even if pendingCalls emptied", () => {
  const cred = classifyApprovalElement(["approval-head"], {
    textContent: "Approval required — 1 tool call(s)",
  }, liveTask({ pendingCalls: [], agentState: "awaiting_approval" }));
  assert.equal(cred, "approval");
});

test("an approval card is stale once the task moved on with no pending decisions", () => {
  const cred = classifyApprovalElement(["approval-head"], {
    textContent: "Approval required — 1 tool call(s)",
  }, liveTask({ pendingCalls: [], agentState: "done" }));
  assert.equal(cred, "stale");
});

test("a ProviderWaitCard is detected and correctly attributed", () => {
  const cred = classifyApprovalElement(["approval-head"], {
    textContent: "Waiting for ChatGPT's reply…",
  }, liveTask());
  assert.equal(cred, "provider-wait");
});

test("the provider-wait matcher works for any provider name", () => {
  const cred = classifyApprovalElement(["approval-head"], {
    textContent: "Waiting for Claude's reply… 12s",
  }, liveTask());
  assert.equal(cred, "provider-wait");
});

test("a bridge approval card is detected via its distinctive head text", () => {
  const cred = classifyApprovalElement(["approval-head"], {
    textContent: "Approval required — browser extension request",
  }, liveTask());
  assert.equal(cred, "bridge-approval");
});

test("cards with an explicit terminal-state message are reclassified as stale", () => {
  const cases = [
    "Approval request timed out after 120 seconds; not executed",
    "Decision no longer matches the pending request; ignored",
  ];
  for (const textContent of cases) {
    const cred = classifyApprovalElement(["approval-head"], { textContent }, liveTask());
    assert.equal(cred, "stale", textContent);
  }
});

test("pruneApprovalCards removes stale cards and keeps fresh ones", () => {
  const { el, removed } = makeDom();
  const stale = el("Approval request timed out after 120 seconds; not executed");
  const fresh = el("Approval required — 1 tool call(s)");
  let notes = 0;
  pruneApprovalCards([stale, fresh], liveTask(), () => {
    notes += 1;
    return "stale approval card removed";
  });
  assert.deepEqual(removed, ["Approval request timed out after 120 seconds; not executed"]);
  assert.equal(notes, 1);
});

test("pruneApprovalCards keeps approval cards for the current task and emits no notes", () => {
  const { el, removed } = makeDom();
  const card = el("Approval required — 1 tool call(s)");
  let notes = 0;
  pruneApprovalCards([card], liveTask(), () => {
    notes += 1;
    return "should not be called";
  });
  assert.deepEqual(removed, []);
  assert.equal(notes, 0);
});

test("pruneApprovalCards removes a timed-out card even while awaiting_approval", () => {
  // A defensive case: the task says awaiting_approval but the card's own text
  // proves its request already timed out — it can never be honoured again.
  const { el, removed } = makeDom();
  const stale = el("Approval request timed out after 120 seconds; not executed");
  const live = el("Approval required — 1 tool call(s)");
  pruneApprovalCards([stale, live], liveTask({ pendingCalls: [], agentState: "awaiting_approval" }), () => "removed");
  assert.deepEqual(removed, ["Approval request timed out after 120 seconds; not executed"]);
});

// ---- Checkpoint 5: late backend approval responses -------------------------
test("a queue bundled with awaiting_approval state mounts a fresh card set", () => {
  // Rust emits approval-request WITH agent-state awaiting_approval in the
  // same event; this is the normal live path.
  assert.equal(
    shouldAcceptApprovalEvent(
      { pendingCalls: [{ id: "req-9" }], state: "awaiting_approval" },
      liveTask({ agentState: "waiting_for_ai", pendingCalls: [] }),
    ),
    true,
  );
});

test("a queue is accepted while a decision is already open in the store", () => {
  assert.equal(
    shouldAcceptApprovalEvent(
      { pendingCalls: [{ id: "req-2" }], state: null },
      liveTask(), // agentState executing
    ),
    true,
  );
  assert.equal(
    shouldAcceptApprovalEvent(
      { pendingCalls: [{ id: "req-2" }], state: null },
      liveTask({ agentState: "awaiting_approval" }),
    ),
    true,
  );
});

test("a late response after the task moved on cannot recreate an expired card", () => {
  assert.equal(
    shouldAcceptApprovalEvent(
      { pendingCalls: [{ id: "req-stale" }], state: "completed" },
      liveTask({ agentState: "done", pendingCalls: [] }),
    ),
    false,
  );
  assert.equal(
    shouldAcceptApprovalEvent(
      { pendingCalls: [{ id: "req-stale" }], state: null },
      liveTask({ agentState: "idle", pendingCalls: [] }),
    ),
    false,
  );
});

test("an empty late queue is still accepted so clearing events always pass", () => {
  assert.equal(
    shouldAcceptApprovalEvent(
      { pendingCalls: [], state: null },
      liveTask({ agentState: "done", pendingCalls: [] }),
    ),
    true,
  );
});
