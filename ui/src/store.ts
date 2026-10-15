// Tiny observable store (no external state lib — keeps the bundle small).
import { useState, useEffect } from "preact/hooks";
import type { AgentState, PendingCall, Settings, TaskMeta, TranscriptEntry, Adapter, WorkspaceEntry } from "./types";

export type View = "chat" | "provider" | "automations" | "marketplace" | "search" | "task";

export interface Toast { id: number; level: "info" | "warn" | "error"; text: string }

export interface State {
  view: View;
  entries: TranscriptEntry[];
  agentState: AgentState;
  agentText: string | null;
  taskId: string | null;
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
}

const initial: State = {
  view: "chat",
  entries: [],
  agentState: "idle",
  agentText: null,
  taskId: null,
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
  providerSelected: "manual",
  providerModels: [],
  searchResults: [],
  searchQuery: "",
  taskStartedAt: null,
  settingsOpen: false,
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
    entries: [], taskId: null, agentState: "idle", agentText: null, pendingCalls: [],
    relayOutbound: null, commandChunks: {}, openTask: null, taskStartedAt: null, view: "chat",
  });
}
