// Step 3 — project-context helpers shared by the composer and its tests.
//
// The backend runs the selection (src-tauri/src/context.rs) and returns
// metadata only. These helpers turn that metadata into the exact text the user
// sees, so the summary/rows can be asserted in a plain node test.

export interface ContextFile {
  path: string;
  start_line: number;
  end_line: number;
  bytes: number;
}

export interface ContextPreview {
  enabled: boolean;
  budget_bytes: number;
  bytes: number;
  considered: number;
  truncated: boolean;
  scan_capped: boolean;
  omitted: number;
  excluded_by_user: number;
  skipped: { binary: number; oversized: number; unreadable: number; outside: number };
  files: ContextFile[];
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

/// Summary line shown in the composer without opening the panel.
export function contextSummary(preview: ContextPreview | null, enabled = true): string {
  if (!enabled) return "Project context off";
  if (!preview) return "Project context · checking…";
  if (!preview.enabled) return "Project context off (disabled in Settings)";
  const files = preview.files.length;
  if (files === 0) {
    return `Project context · no matching files · ${preview.considered} scanned`;
  }
  const parts = [
    `${files} file${files === 1 ? "" : "s"}`,
    `${formatBytes(preview.bytes)} of ${formatBytes(preview.budget_bytes)}`,
  ];
  if (preview.truncated || preview.omitted > 0) parts.push("truncated");
  return `Project context · ${parts.join(" · ")}`;
}

export interface ContextRow {
  path: string;
  checked: boolean;
  detail: string;
}

/// Rows for the veto list: included files first, then paths the user removed
/// (they stay visible so an exclusion can be undone before sending).
export function contextRows(preview: ContextPreview | null, excluded: string[] = []): ContextRow[] {
  const removed = new Set(excluded);
  const included = (preview?.files ?? []).map((file) => ({
    path: file.path,
    // A file stays listed (unchecked) while the backend rescans without it, so
    // the veto can be undone without waiting for another preview.
    checked: !removed.has(file.path),
    detail: file.start_line === file.end_line
      ? `line ${file.start_line} · ${formatBytes(file.bytes)}`
      : `lines ${file.start_line}–${file.end_line} · ${formatBytes(file.bytes)}`,
  }));
  const seen = new Set(included.map((row) => row.path));
  const extras = excluded
    .filter((path) => !seen.has(path))
    .map((path) => ({ path, checked: false, detail: "excluded for this task" }));
  return [...included, ...extras];
}

/// One-line honest note about what was skipped or omitted, or "" when the
/// selection was complete.
export function contextCaveat(preview: ContextPreview | null): string {
  if (!preview) return "";
  const notes: string[] = [];
  if (preview.omitted > 0) notes.push(`${preview.omitted} matching file(s) omitted for budget`);
  if (preview.scan_capped) notes.push("workspace scan limit reached");
  const s = preview.skipped;
  const skipped = [
    s.binary ? `${s.binary} binary` : "",
    s.oversized ? `${s.oversized} oversized` : "",
    s.unreadable ? `${s.unreadable} unreadable` : "",
    s.outside ? `${s.outside} outside workspace` : "",
  ].filter(Boolean);
  if (skipped.length) notes.push(`skipped ${skipped.join(", ")}`);
  if (preview.excluded_by_user > 0) notes.push(`${preview.excluded_by_user} excluded by you`);
  return notes.join(" · ");
}
