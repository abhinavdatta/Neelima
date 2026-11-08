// Tiny observable store (no external state lib — keeps the bundle small).
import { useState, useEffect } from "preact/hooks";
import type { AgentState, PendingCall, Settings, TaskMeta, TranscriptEntry, Adapter, WorkspaceEntry } from "./types";
import type { ProviderRequestStatus } from "./providerStatus";
import type { AgentChange } from "./agentChanges";
import type { EditorContextItem } from "./editorContext";

export type View = "chat" | "provider" | "automations" | "marketplace" | "search" | "task" | "files";

export interface Toast { id: number; level: "info" | "warn" | "error"; text: string }

export interface State {
  view: View;
  entries: TranscriptEntry[];
  agentState: AgentState;
  agentText: string | null;
  /// Live, display-only preview of an in-progress provider reply (local model
  /// chunks appended; web provider sends a capped accumulated tail).
  streamText: string;
  taskId: string | null;
  taskStartPending: boolean;
  taskStartRequestId: string | null;
  activeTaskSkills: string[];
  pendingCalls: PendingCall[];
  relayOutbound: string | null;
  commandChunks: Record<string, string>;
  settings: Settings | null;
  adapters: Adapter[];
  providers: any;
  workspaces: WorkspaceEntry[];
  activeWorkspace: string | null;
  activeWorkspacePath: string | null;
  tasks: TaskMeta[];
  openTask: TaskMeta | null;
  toasts: Toast[];
  terminalOpen: boolean;
  diffEntry: {
    taskId: string;
    entryId: number;
    /** In-app preview (agent proposal or a native editor save). */
    preview?: { path: string; old: string; new: string; apply?: () => Promise<void> };
  } | null;
  providerSelected: string; // provider id for the composer chip
  providerModels: string[];
  searchResults: TaskMeta[];
  searchQuery: string;
  taskStartedAt: number | null;
  settingsOpen: boolean;
  composerText: string;
  providerMounted: boolean;
  providerAuthOpen: boolean;
  providerLoginWaiting: boolean;
  providerLoginState: "unknown" | "loading" | "challenge" | "logged_in" | "logged_out";
  providerBridgeError: string | null;
  /// Latest provider request-contract state (metadata only; never reply text).
  providerRequest: ProviderRequestStatus | null;
  /// Human-readable note about a rejected/late provider push or a bounded
  /// protocol event, shown next to the provider wait state.
  providerEventNote: string | null;
  /// Why the provider's sign-in state could not be confirmed, if it could not.
  providerLoginReason: string | null;
  /// Bounded, metadata-only record of provider lifecycle events the UI
  /// actually received (no prompt or reply text). Included in diagnostics.
  providerEvents: Array<{ state: string; at: number; requestId: string | null }>;
  bridgeApproval: { request_id: string; tool: string; args: any; site: string; risk: string } | null;
  /// Multi-tab native editor documents. `editorWorkspaceTag` records which
  /// workspace the stored drafts belong to: when the active workspace changes
  /// the documents are dropped (stale drafts would save into the wrong tree).
  editorDocs: import("./editorTabs").DocRec[];
  editorActivePath: string;
  editorWorkspaceTag: string | null;
  /// CP9: explicit, one-shot editor context attached to the next prompt. The
  /// workspace is stored on every item; only the current workspace's items are
  /// displayed or sent. Cleared on task reset and after an accepted prompt.
  editorContexts: EditorContextItem[];
  /// Verified agent writes (CP6). Bounded, deduped by task/call/path; the
  /// workspace tag is part of every entry so another tree's change is ignored.
  agentChanges: AgentChange[];
  /// Change keys already reconciled by the explorer (CP10). This lives in the
  /// session store, not in FileTree, so switching away from Files does not
  /// forget which changes still need their row marker / clean-tab reload.
  agentHandledKeys: string[];
  /// Increments once per accepted change, so the explorer reconciles on real
  /// events instead of polling.
  agentChangeTick: number;
}

const initial: State = {
  view: "chat",
  entries: [],
  agentState: "idle",
  agentText: null,
  streamText: "",
  taskId: null,
  taskStartPending: false,
  taskStartRequestId: null,
  activeTaskSkills: [],
  pendingCalls: [],
  relayOutbound: null,
  commandChunks: {},
  settings: null,
  adapters: [],
  providers: null,
  workspaces: [],
  activeWorkspace: null,
  activeWorkspacePath: null,
  tasks: [],
  openTask: null,
  toasts: [],
  terminalOpen: false,
  diffEntry: null,
  providerSelected: "ollama",
  providerModels: [],
  searchResults: [],
  searchQuery: "",
  taskStartedAt: null,
  settingsOpen: false,
  composerText: "",
  providerMounted: false,
  providerAuthOpen: false,
  providerLoginWaiting: false,
  providerLoginState: "unknown",
  providerBridgeError: null,
  providerRequest: null,
  providerEventNote: null,
  providerLoginReason: null,
  providerEvents: [],
  bridgeApproval: null,
  editorDocs: [],
  editorActivePath: "",
  editorWorkspaceTag: null,
  editorContexts: [],
  agentChanges: [],
  agentHandledKeys: [],
  agentChangeTick: 0,
};

let state: State = initial;
const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === "function" ? (patch as (s: State) => Partial<State>)(state) : patch;
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}

export function useStore(): State {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return state;
}

let toastId = 0;
export function toast(level: Toast["level"], text: string) {
  const id = ++toastId;
  setState((s) => ({ toasts: [...s.toasts, { id, level, text }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 6000);
}

export function resetTask() {
  setState({
    entries: [], taskId: null, taskStartPending: false, taskStartRequestId: null, activeTaskSkills: [], agentState: "idle", agentText: null, streamText: "", pendingCalls: [],
    relayOutbound: null, commandChunks: {}, openTask: null, taskStartedAt: null, view: "chat", composerText: "", editorContexts: [],
    providerRequest: null, providerEventNote: null, providerEvents: [],
  });
}
