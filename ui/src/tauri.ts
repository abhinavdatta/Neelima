// Thin typed wrappers over the Tauri command surface + the single "evt" event
// channel. Every command here is label-checked on the Rust side.
import { invoke } from "@tauri-apps/api/core";
import type { Adapter, Settings, TaskMeta, TranscriptEntry } from "./types";

export const cmd = {
  pickWorkspace: () => invoke<string | null>("ui_pick_workspace"),
  workspaceAdd: (path: string) => invoke<{ name: string; path: string }>("ui_workspace_add", { path }),
  workspaceList: () => invoke<{ workspaces: any[]; active: string | null }>("ui_workspace_list"),
  workspaceUse: (id: string) => invoke<void>("ui_workspace_use", { id }),
  workspaceRemove: (id: string) => invoke<{ removed: string; path: string }>("ui_workspace_remove", { id }),
  workspaceRename: (id: string, name: string) => invoke<{ id: string; name: string }>("ui_workspace_rename", { id, name }),
  workspaceOpenInExplorer: (id?: string) => invoke<void>("ui_workspace_open_in_explorer", { id: id ?? null }),
  tree: (path: string) => invoke<{ path: string; entries: { name: string; dir: boolean; path: string }[] }>("ui_tree", { path }),
  settingsGet: () => invoke<Settings>("ui_settings_get"),
  settingsSet: (s: Settings) => invoke<Settings>("ui_settings_set", { next: s }),
  adaptersList: () => invoke<Adapter[]>("ui_adapters_list"),
  adaptersOpenFolder: () => invoke<void>("ui_adapters_open_folder"),
  inspectorStart: (name: string, url: string) => invoke<void>("ui_adapter_start_inspector", { name, url }),
  inspectorCapture: (kind: string) => invoke<{ kind: string; selector: string }>("ui_adapter_capture", { kind }),
  inspectorFinish: () => invoke<Adapter>("ui_adapter_finish_inspector"),
  providersLogin: (profileId: string) => invoke<void>("ui_providers_login", { profileId }),
  providersClose: () => invoke<void>("ui_providers_close"),
  providersList: () => invoke<any>("ui_providers_list"),
  modelsLocal: (kind: "ollama" | "lmstudio") => invoke<string[]>("ui_models_local", { kind }),
  taskStart: (prompt: string, providerId: string) => invoke<string>("ui_task_start", { prompt, providerId }),
  taskStop: () => invoke<void>("ui_task_stop"),
  taskContinue: (taskId: string, providerId: string) => invoke<string>("ui_task_continue", { taskId, providerId }),
  approve: (decisions: { id: string; approved: boolean }[]) => invoke<void>("ui_approve", { decisions }),
  relayReply: (text: string) => invoke<void>("ui_relay_reply", { text }),
  webviewMode: (mode: "provider" | "chat") => invoke<void>("ui_webview_mode", { mode }),
  webviewRect: (x: number, y: number, w: number, h: number) => invoke<void>("ui_webview_rect", { x, y, w, h }),
  termCreate: () => invoke<number>("ui_terminal_create"),
  termWrite: (id: number, data: string) => invoke<void>("ui_terminal_write", { id, data }),
  termResize: (id: number, rows: number, cols: number) => invoke<void>("ui_terminal_resize", { id, rows, cols }),
  termKill: (id: number) => invoke<void>("ui_terminal_kill", { id }),
  checkpoints: () => invoke<any[]>("ui_checkpoint_list"),
  checkpointCreate: (label: string) => invoke<any>("ui_checkpoint_create", { label }),
  checkpointRestore: (id: string) => invoke<any>("ui_checkpoint_restore", { id }),
  historyTasks: () => invoke<TaskMeta[]>("ui_history_tasks"),
  historyOpen: (taskId: string) => invoke<TranscriptEntry[]>("ui_history_open", { taskId }),
  searchTasks: (q: string) => invoke<TaskMeta[]>("ui_search_tasks", { q }),
  diffGet: (taskId: string, entryId: number) => invoke<{ path: string; old: string; new: string }>("ui_diff_get", { taskId, entryId }),
  appInfo: () => invoke<any>("ui_app_info"),
};

export { listen } from "@tauri-apps/api/event";
