// Tiny observable store (no external state lib — keeps the bundle small).
import { useState, useEffect } from "preact/hooks";
import type { AgentState, PendingCall, Settings, TaskMeta, TranscriptEntry, Adapter, WorkspaceEntry } from "./types";
import type { ProviderRequestStatus } from "./providerStatus";

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
  diffEntry: { taskId: string; entryId: number } | null;
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
    relayOutbound: null, commandChunks: {}, openTask: null, taskStartedAt: null, view: "chat", composerText: "",
    providerRequest: null, providerEventNote: null, providerEvents: [],
  });
}
