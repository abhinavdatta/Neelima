// Terminal agent states. A cancelled task is finished: the loop has stopped,
// the backend has written its history entry, and the composer is usable again.
// Phase 3M live defect: TitleBar's "running" check omitted "cancelled", so
// pressing Stop left the Stop pill and a disabled Send button in place forever.
const TERMINAL = new Set(["idle", "done", "error", "cancelled"]);

export function isAgentRunning(state: string | null | undefined): boolean {
  if (!state) return false;
  return !TERMINAL.has(state);
}

export function isTerminalAgentState(state: string | null | undefined): boolean {
  return !!state && TERMINAL.has(state);
}
