// Pure reducer for the provider response-contract lifecycle. Kept free of
// Preact/store imports so it can be unit-tested directly with node --test.

export type ProviderRequestState =
  | "created"
  | "queued"
  | "submitting"
  | "submitted"
  | "submission_unconfirmed"
  | "streaming"
  | "cancel_requested"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "unknown";

export interface ProviderRequestStatus {
  requestId: string | null;
  provider: string | null;
  state: ProviderRequestState;
  at: number;
  category?: string;
}

export interface ProviderRequestPatch {
  providerRequest: ProviderRequestStatus;
  clearStream: boolean;
  toast?: { level: "info" | "warn" | "error"; text: string };
}

const VALID_STATES = new Set<string>([
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
]);

const TERMINAL_STATES = new Set<string>([
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "unknown",
]);

export function isTerminalProviderState(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

export function providerStateLabel(state: string | undefined): string {
  switch (state) {
    case "created":
      return "preparing";
    case "queued":
      return "queued";
    case "submitting":
      return "submitting";
    case "submitted":
      return "submitted";
    case "submission_unconfirmed":
      return "submission unconfirmed";
    case "streaming":
      return "streaming";
    case "cancel_requested":
      return "cancelling…";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "timed_out":
      return "timed out";
    case "cancelled":
      return "cancelled";
    case "unknown":
      return "outcome unknown";
    default:
      return "waiting";
  }
}

export function failureCategoryLabel(category: string | undefined): string {
  switch (category) {
    case "login_required":
      return "sign-in required";
    case "page_unavailable":
      return "provider page unavailable";
    case "page_changed":
      return "provider page changed";
    case "busy":
      // The provider window is still bound to another profile: the request was
      // never attempted, so this is not a page/selector problem.
      return "provider window busy";
    case "timeout":
      return "provider timeout";
    case "send_failed":
      return "send failed";
    case "unavailable":
      return "local runtime unreachable";
    case "provider_error":
      return "provider error";
    case "config":
      return "provider not configured";
    case "closed":
      return "relay closed";
    default:
      return category || "unknown";
  }
}

/**
 * Apply one `provider-request-state` event. Returns null for events the UI
 * cannot use (unknown state, no state). Mirrors the backend guard: once a
 * request reports a terminal state, later transitions for the same request are
 * ignored, so a late partial or a racing error path cannot repaint the UI.
 */
export function reduceProviderRequestEvent(
  current: ProviderRequestStatus | null,
  event: any,
): ProviderRequestPatch | null {
  const state = event?.state;
  if (typeof state !== "string" || !VALID_STATES.has(state)) return null;
  const requestId = typeof event.request_id === "string" ? event.request_id : null;
  if (
    current &&
    current.requestId &&
    current.requestId === requestId &&
    isTerminalProviderState(current.state)
  ) {
    return { providerRequest: current, clearStream: false };
  }
  const status: ProviderRequestStatus = {
    requestId,
    provider:
      typeof event.provider === "string"
        ? event.provider
        : current?.provider ?? null,
    state: state as ProviderRequestState,
    at: typeof event.at_ms === "number" ? event.at_ms : Date.now(),
    category: typeof event.error_category === "string" ? event.error_category : undefined,
  };
  const clearStream =
    state === "completed" ||
    state === "failed" ||
    state === "timed_out" ||
    state === "cancelled" ||
    state === "unknown" ||
    state === "cancel_requested";
  const patch: ProviderRequestPatch = { providerRequest: status, clearStream };
  // The agent loop already surfaces terminal failures. The one outcome it
  // cannot explain is an unconfirmed submission; say it once, without text.
  if (
    state === "submission_unconfirmed" &&
    (!current || current.requestId !== requestId || current.state !== "submission_unconfirmed")
  ) {
    patch.toast = {
      level: "warn",
      text: "The provider did not confirm the prompt was accepted. Neelima is waiting for a reply without resending it.",
    };
  }
  // An indeterminate outcome must be stated once, honestly, never guessed.
  if (
    state === "unknown" &&
    (!current || current.requestId !== requestId || current.state !== "unknown")
  ) {
    patch.toast = {
      level: "warn",
      text: "The request finished with an unknown outcome — Neelima can prove neither a reply nor a specific failure. Check the provider conversation before retrying.",
    };
  }
  return patch;
}

/**
 * Correlation gate for live preview chunks (Step 2, E). Returns how the text
 * should be applied, or null when the chunk must be DROPPED:
 * - it belongs to no known request while a different request is active,
 * - its request ID (or provider) differs from the currently tracked request,
 * - the tracked request already reached a terminal state or a cancel was
 *   requested (late chunks can never repaint a finished round).
 * `assistant-stream` chunks are deltas (append); `assistant-partial` carries
 * the accumulated tail (replace).
 */
export function reduceStreamEvent(
  current: ProviderRequestStatus | null,
  event: any,
  kind: "assistant-stream" | "assistant-partial",
): { text: string; mode: "append" | "replace" } | null {
  if (typeof event?.text !== "string" || !event.text) return null;
  const requestId = typeof event.request_id === "string" ? event.request_id : null;
  const provider = typeof event.provider === "string" ? event.provider : null;
  if (current) {
    if (isTerminalProviderState(current.state)) return null;
    if (current.state === "cancel_requested") return null;
    if (requestId && current.requestId && requestId !== current.requestId) return null;
    if (provider && current.provider && provider !== current.provider) return null;
  }
  return { text: event.text, mode: kind === "assistant-partial" ? "replace" : "append" };
}

/** Metadata-only description of a rejected assistant push. */
export function describePushRejection(event: any): string {
  const reason = typeof event?.reason === "string" ? event.reason : "unknown reason";
  const seq = typeof event?.seq === "number" ? ` #${event.seq}` : "";
  return `A provider reply${seq} was rejected: ${reason}.`;
}
