// Pure terminal-panel helpers. The xterm/FitAddon objects and Tauri calls stay
// in TerminalPanel; these functions are small enough to test without a DOM.

export type TerminalEvent =
  | { kind: "term-data"; session: number; data: string }
  | { kind: "term-exit"; session: number; code?: number | null };

export type TerminalStatus =
  | { kind: "noworkspace" }
  | { kind: "connecting" }
  | { kind: "running" }
  | { kind: "exited"; code: number | null }
  | { kind: "error"; message: string };

/** Byte bound for output that arrives before the PTY id is known. */
export const TERMINAL_PENDING_LIMIT = 256 * 1024;

// UTF-8 length, not UTF-16 code units: a chunk of astral characters must not
// be allowed to retain four times the documented bound.
const encoder = new TextEncoder();
const eventBytes = (event: TerminalEvent) =>
  event.kind === "term-data" ? encoder.encode(event.data).length : 0;

/**
 * Append an event while keeping the pre-session buffer bounded. Oldest chunks
 * are discarded first; an `exit` event is kept because it carries the only
 * status information. The input array is never mutated.
 */
export function bufferTerminalEvent(
  queue: readonly TerminalEvent[],
  event: TerminalEvent,
  limit = TERMINAL_PENDING_LIMIT,
): TerminalEvent[] {
  const next = [...queue, event];
  let bytes = next.reduce((total, item) => total + eventBytes(item), 0);
  while (bytes > limit && next.length > 1) {
    // Exit events are never evicted, even if a slow reader delivers final data
    // after one. Drop the oldest data event instead.
    const index = next.findIndex((item) => item.kind !== "term-exit");
    if (index < 0) break;
    const [removed] = next.splice(index, 1);
    bytes -= eventBytes(removed);
  }
  return next;
}

export function terminalExitText(code?: number | null): string {
  const suffix = typeof code === "number" ? ` (code ${code})` : "";
  return `\r\n\x1b[90m[terminal process exited${suffix}]\x1b[0m`;
}

export function terminalWorkspaceName(path: string | null): string {
  if (!path) return "workspace";
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || "workspace";
}

export function terminalStatusText(status: TerminalStatus): string {
  switch (status.kind) {
    case "noworkspace":
      return "No workspace";
    case "connecting":
      return "Starting…";
    case "running":
      return "Live";
    case "exited":
      return status.code === null ? "Exited" : `Exited (${status.code})`;
    case "error":
      return "Failed";
  }
}
