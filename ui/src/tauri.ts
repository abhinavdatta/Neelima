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
  // CP5: the listing reports whether it was capped (and how many entries could
  // not be read) so the explorer can state the truth instead of implying the
  // folder is complete.
  tree: (path: string) => invoke<{ path: string; entries: { name: string; dir: boolean; path: string }[]; truncated?: boolean; limit?: number; unreadable?: number }>("ui_tree", { path }),
  filePreview: (path: string, offset = 0) => invoke<{ path: string; content: string; offset: number; line_limit: number; size_bytes: number; has_more: boolean }>("ui_file_preview", { path, offset }),
  fileText: (path: string) => invoke<{ path: string; content: string; bytes: number }>("ui_file_text", { path }),
  // Checkpoint 4: `expectedOriginal` is the exact baseline the reviewed diff
  // was computed against; the Rust command re-verifies it against the disk
  // right before the atomic replacement and rejects with "CONFLICT::…" when
  // the file changed externally. It is REQUIRED (CP4 closeout): there is no
  // baseline-free save path, on either side of the boundary.
  fileSave: (path: string, content: string, expectedOriginal: string) =>
    invoke<{ path: string; bytes: number; lines: number }>("ui_file_save", {
      path,
      content,
      expectedOriginal,
    }),
  settingsGet: () => invoke<Settings>("ui_settings_get"),
  settingsSet: (s: Settings) => invoke<Settings>("ui_settings_set", { next: s }),
  adaptersList: () => invoke<Adapter[]>("ui_adapters_list"),
  adaptersOpenFolder: () => invoke<void>("ui_adapters_open_folder"),
  inspectorStart: (name: string, url: string) => invoke<void>("ui_adapter_start_inspector", { name, url }),
  inspectorCapture: (kind: string) => invoke<{ kind: string; selector: string }>("ui_adapter_capture", { kind }),
  inspectorFinish: () => invoke<Adapter>("ui_adapter_finish_inspector"),
  providersLogin: (profileId: string) => invoke<void>("ui_providers_login", { profileId }),
  providersClose: () => invoke<void>("ui_providers_close"),
  providerClearSession: (profileId: string) => invoke<void>("ui_provider_clear_session", { profileId }),
  providersList: () => invoke<any>("ui_providers_list"),
  providerDiagnose: () => invoke<any>("ui_provider_diagnose"),
  requestLog: () => invoke<any[]>("ui_request_log"),
  providerMarkSignedIn: () => invoke<void>("ui_provider_mark_signed_in"),
  captureReply: () => invoke<{ delivered: boolean; len?: number; reason?: string }>("ui_capture_reply"),
  providerProbe: (providerId: string) => invoke<{ ok: boolean; ready: boolean; reply: string; elapsed_ms: number; request_id: string | null }>("ui_provider_probe", { providerId }),
  modelsLocal: (kind: "ollama" | "lmstudio") => invoke<string[]>("ui_models_local", { kind }),
  contextPreview: (prompt: string, providerId: string, exclude: string[] = [], taskId: string | null = null) =>
    invoke<import("./contextPreview").ContextPreview>("ui_context_preview", { prompt, providerId, exclude, taskId }),
  taskStart: (prompt: string, providerId: string, requestId: string, skillIds: string[] = [], skillBudget = 8192, context: { enabled: boolean; exclude: string[] } = { enabled: true, exclude: [] }) =>
    invoke<string>("ui_task_start", { prompt, providerId, skillIds, skillBudget, requestId, context }),
  taskStop: () => invoke<void>("ui_task_stop"),
  taskContinue: (taskId: string, providerId: string, prompt: string, requestId: string, context: { enabled: boolean; exclude: string[] } = { enabled: true, exclude: [] }) =>
    invoke<string>("ui_task_continue", { taskId, providerId, prompt, requestId, context }),
  approve: (decisions: { id: string; approved: boolean }[]) => invoke<void>("ui_approve", { decisions }),
  bridgeApprove: (requestId: string, approved: boolean, reason?: string) => invoke<boolean>("browser_bridge_decide", { requestId, approved, reason: reason ?? null }),
  relayReply: (text: string) => invoke<void>("ui_relay_reply", { text }),
  webviewMode: (mode: "provider" | "chat") => invoke<void>("ui_webview_mode", { mode }),
  webviewRect: (x: number, y: number, w: number, h: number) => invoke<void>("ui_webview_rect", { x, y, w, h }),
  syncViewport: () => invoke<void>("ui_sync_viewport"),
  termCreate: () => invoke<number>("ui_terminal_create"),
  termWrite: (id: number, data: string) => invoke<void>("ui_terminal_write", { id, data }),
  termResize: (id: number, rows: number, cols: number) => invoke<void>("ui_terminal_resize", { id, rows, cols }),
  termKill: (id: number) => invoke<void>("ui_terminal_kill", { id }),
  checkpoints: () => invoke<any[]>("ui_checkpoint_list"),
  checkpointCreate: (label: string) => invoke<any>("ui_checkpoint_create", { label }),
  checkpointRestorePreview: (id: string) => invoke<{ checkpoint: string; checkpoint_files: number; tracked_files_to_remove: number }>("ui_checkpoint_restore_preview", { id }),
  checkpointRestore: (id: string) => invoke<any>("ui_checkpoint_restore", { id }),
  historyTasks: () => invoke<TaskMeta[]>("ui_history_tasks"),
  historyOpen: (taskId: string) => invoke<TranscriptEntry[]>("ui_history_open", { taskId }),
  searchTasks: (q: string) => invoke<TaskMeta[]>("ui_search_tasks", { q }),
  diffGet: (taskId: string, entryId: number) => invoke<{ path: string; old: string; new: string }>("ui_diff_get", { taskId, entryId }),
  taskRename: (id: string, title: string) => invoke<{ id: string; title: string }>("ui_task_rename", { id, title }),
  taskDelete: (id: string) => invoke<{ removed: string }>("ui_task_delete", { id }),
  appInfo: () => invoke<any>("ui_app_info"),
  skillsList: () => invoke<any[]>("ui_skills_list"),
  skillPreview: (repoUrl: string, branch: string, path: string, location: string) => invoke<any>("ui_skill_preview", { repoUrl, branch, path, location }),
  skillInstall: (preview: any, location: string, replaceExisting: boolean) => invoke<any>("ui_skill_install", { preview, location, replaceExisting }),
  skillSetEnabled: (location: string, id: string, enabled: boolean) => invoke<void>("ui_skill_set_enabled", { location, id, enabled }),
  skillUninstall: (location: string, id: string) => invoke<void>("ui_skill_uninstall", { location, id }),
  skillReveal: (location: string, id: string) => invoke<void>("ui_skill_reveal", { location, id }),
  skillUpdatePreview: (location: string, id: string) => invoke<any>("ui_skill_update_preview", { location, id }),
  skillRead: (location: string, id: string) => invoke<string>("ui_skill_read", { location, id }),
  openGitHub: (url: string) => invoke<void>("ui_open_github", { url }),
};

export { listen } from "@tauri-apps/api/event";
