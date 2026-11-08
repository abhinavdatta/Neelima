// Pure approval-card lifecycle rules, kept free of DOM/Preact surface so they
// can be unit-tested without a renderer. Follows the ui/src/fileEdit.ts guard
// pattern of an explicit taxonomy for every classification.
//
// Background: the browser-bridge approval path and task transitions (retry,
// stop, finish) can leave a card mounted whose decision can no longer be
// honoured — the request behind it already timed out, was refused, or belonged
// to a task that has since changed state. The rules below drive pruning and
// UI note counters; they never decide approvals themselves.

export type ApprovalCardGroup =
  | "approval"
  | "bridge-approval"
  | "provider-wait"
  | "none";

export type ApprovalCardClassification = ApprovalCardGroup | "stale";

/** Text that proves the card's decision already resolved one way or another. */
export const TERMINAL_TEXT_MARKERS = [
  "timed out after",
  "Timed out after",
  "Decision no longer matches",
] as const;

/** Text of the distinctive heads that stay mounted through transitions. */
/** Any provider wait card: "Waiting for <provider>'s reply…". */
export function isProviderWaitText(t: string): boolean {
  return t.startsWith("Waiting for ") && t.includes("'s reply");
}
export const BRIDGE_APPROVAL_TEXT = "Approval required — browser extension request" as const;
export const APPROVAL_PROMISE_PREFIX = "Approval required — " as const;

/**
 * Decide which lifecycle group an approval-shaped element belongs to, or
 * `stale` when its decision can no longer be honoured.
 *
 * Order matters:
 *  1. Terminal-status text always wins — the request behind it is finished.
 *  2. Distinctive heads (bridge card, provider wait card) are attributed
 *     directly; their lifecycles differ from agent approval cards.
 *  3. The approval promise text is honoured only while a live decision is
 *     still possible: pending calls queued, or the agent explicitly waiting
 *     on approval. Otherwise the card is stale.
 *
 * @returns approval / bridge-approval / provider-wait / stale / none.
 */
export function classifyApprovalElement(
  _classes: ArrayLike<string> | string[] | undefined,
  textLike: { textContent: string },
  task: { taskId: string; pendingCalls: unknown[]; bridgeApproval: unknown; agentState: string },
): ApprovalCardClassification {
  const t = textLike.textContent;
  if (TERMINAL_TEXT_MARKERS.some((s) => t.includes(s))) {
    return "stale";
  }
  if (t.includes(BRIDGE_APPROVAL_TEXT)) {
    return "bridge-approval";
  }
  if (isProviderWaitText(t)) {
    return "provider-wait";
  }
  if (t.startsWith(APPROVAL_PROMISE_PREFIX)) {
    if (task.pendingCalls.length > 0 || task.agentState === "awaiting_approval") {
      return "approval";
    }
    return "stale";
  }
  return "none";
}

/**
 * Can a backend `approval-request` event legitimately mount a fresh card set?
 *
 * Rust emits approval-request WITH agent-state `awaiting_approval` in the same
 * event, so a live queue always arrives either bundled with that state or
 * while a decision is still open in the store (awaiting_approval/executing).
 * Anything else is a late response that arrived after the task moved on:
 * refusing it here means an expired or cancelled request can never recreate a
 * card, instead of relying on the 400 ms sweep to clean up the flash. Empty
 * queues (clearing events) always pass — dropping state never mis-leads.
 * Pure function; never decides an approval itself.
 */
export function shouldAcceptApprovalEvent(
  incoming: { pendingCalls: unknown[]; state?: string | null },
  task: { pendingCalls: unknown[]; bridgeApproval: unknown; agentState: string },
): boolean {
  if (incoming.pendingCalls.length === 0) return true;
  if (incoming.state === "awaiting_approval") return true;
  return task.agentState === "awaiting_approval" || task.agentState === "executing";
}

/**
 * Remove any list element whose classification is `stale`, counting changed
 * cards through the caller's note function so throttle ownership stays in the
 * component.
 */
export function pruneApprovalCards(
  candidates: ArrayLike<{ textContent: string; remove: () => void }>,
  task: { taskId: string; pendingCalls: unknown[]; bridgeApproval: unknown; agentState: string },
  note: (text: string) => string,
): void {
  for (const el of Array.from(candidates)) {
    if (classifyApprovalElement(["approval-head"], el, task) === "stale") {
      el.remove();
      note("Removed a stale approval card: its decision can no longer be honoured.");
    }
  }
}
