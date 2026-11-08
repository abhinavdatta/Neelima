// A task belongs to the workspace it started in. Rust refuses a workspace
// switch while a task is active (`workspace cannot be changed while a task is
// active`) and refuses to continue a task from another tree (`select the
// workspace used by this task before continuing it`). The UI must therefore
// drop the finished task view when the workspace root changes — otherwise the
// previous project's transcript stays under the new workspace name and the
// composer offers a continuation that can only fail.

/** Whether moving from `previous` to `next` invalidates the displayed task. */
export function workspaceSwitchClearsTask(
  previous: string | null,
  next: string | null,
): boolean {
  // The first resolved workspace (previous === null) is startup, not a switch.
  if (previous === null) return false;
  return previous !== next;
}

/** Store patch that ends the visible task association but keeps the composer
 * draft (the user's unsent text must survive an accidental project switch). */
export function clearedTaskView() {
  return {
    entries: [],
    taskId: null,
    openTask: null,
    pendingCalls: [],
    commandChunks: {},
    agentText: null,
    streamText: "",
    taskStartedAt: null,
    agentState: "idle" as const,
    diffEntry: null,
    relayOutbound: null,
    activeTaskSkills: [],
  };
}
