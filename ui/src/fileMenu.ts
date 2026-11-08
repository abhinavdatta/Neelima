// Phase 3Q-2b — the file row context menu (pure).
//
// The menu deliberately offers ONLY actions the application can actually keep.
// The command surface is ui_tree / ui_file_preview / ui_file_text / ui_file_save,
// so rename, delete, new file/folder and per-file reveal are absent: showing them
// disabled or as a promise the backend cannot honour is worse than not showing
// them at all.
//
// Path copy is frontend-only (clipboard), so it is safe to offer for any file.

export type FileMenuAction = "open" | "preview" | "copy-relative" | "copy-absolute" | "share";

export interface FileMenuItem {
  id: FileMenuAction;
  label: string;
  /** Set for actions that only make sense with an open editor tab. */
  when?: "always" | "closed";
}

export function fileMenuItems(): FileMenuItem[] {
  return [
    { id: "open", label: "Open in editor" },
    { id: "preview", label: "Preview" },
    { id: "copy-relative", label: "Copy relative path" },
    { id: "copy-absolute", label: "Copy absolute path" },
    { id: "share", label: "Share with chat" },
  ];
}

/**
 * Join the workspace root and a workspace-relative path using the root's own
 * separator, so a Windows workspace yields a Windows path and a POSIX one does
 * not gain backslashes. Only used for the clipboard, never for file access.
 */
export function absoluteWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const root = String(workspaceRoot ?? "").trim();
  const rel = String(relativePath ?? "").replace(/^[\\/]+/, "");
  if (!root) return rel;
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const trimmed = root.replace(/[\\/]+$/, "");
  const joined = `${trimmed}${separator}${rel.split(/[\\/]+/).filter(Boolean).join(separator)}`;
  return separator === "\\" ? joined.replace(/\//g, "\\") : joined;
}

/** Roving focus inside the menu; null means "not a menu key". */
export function menuIndexForKey(current: number, count: number, key: string): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown":
      return (current + 1 + count) % count;
    case "ArrowUp":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
