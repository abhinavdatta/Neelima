// Shared frontend types mirroring the Rust core.

export interface WorkspaceEntry { id: string; name: string; path: string }
export interface WebProfile { id: string; adapter_id: string; name: string }
export interface LocalCfg { url: string; model?: string | null; context_chars?: number | null; temperature?: number | null }
export interface Adapter {
  id: string; name: string; url: string; built_in: boolean;
  selectors: { input: string; send_button: string; stop_button?: string | null; messages: string; new_chat?: string | null; logged_in?: string | null };
  input: { kind: "textarea" | "contenteditable"; max_chars?: number | null };
  quiet_ms: number; response_timeout_ms: number;
}
export interface Settings {
  permission_mode: "ask_all" | "ask_writes" | "full_access";
  max_iterations: number;
  result_cap_bytes: number;
  command_timeout_secs: number;
  shell?: string | null;
  hotkey: string;
  workspaces: WorkspaceEntry[];
  active_workspace_id?: string | null;
  providers: { web: WebProfile[]; ollama?: LocalCfg | null; lmstudio?: LocalCfg | null };
  command_allow: string[];
  command_deny: string[];
  update_check_opt_in: boolean;
}
export interface CallRecord { id: string; tool: string; args: any; status: string; output: string }
export interface DiffInfo { path: string; old: string; new: string }
export interface TranscriptEntry {
  id: number; ts: number; kind: string; text: string;
  calls: CallRecord[]; diff?: DiffInfo | null; injection_warning?: string | null;
}
export interface PendingCall { id: string; tool: string; args: any; risk: string; diff?: { path: string; old: string; new: string } }
export interface TaskMeta { id: string; title: string; started_ms: number; ended_ms?: number | null; workspace: string; provider: string; status: string; iterations: number }
export type ProviderId = string; // "web:<profile>" | "ollama" | "lmstudio" | "manual"

export type AgentState =
  | "idle" | "waiting_for_ai" | "parsing" | "awaiting_approval" | "executing" | "done" | "error";
