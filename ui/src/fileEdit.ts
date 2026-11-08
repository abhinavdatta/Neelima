// Pure guards for the native code editor. Kept separate from the component so
// the "can this be saved?" rule is unit-tested instead of inferred from the UI.
export const EDIT_MAX_BYTES = 1024 * 1024;

/** null when the draft may be sent for a diff; otherwise the reason to block. */
export function editBlockReason(
  original: string,
  draft: string,
  maxBytes: number = EDIT_MAX_BYTES,
): string | null {
  if (draft === original) return "No changes to save";
  if (draft.length > maxBytes) {
    return `Edits are limited to ${Math.floor(maxBytes / 1024)} KB per save; split the change.`;
  }
  return null;
}

/** Rough size label for the editor footer. The dirty wording follows the
 * SAME structural rule as every save/review decision (draft !== original), so
 * a saved document cannot keep claiming it has an unsaved draft. */
export function editStatus(original: string, draft: string): string {
  const before = original.split("\n").length;
  const after = draft.split("\n").length;
  const delta = after - before;
  const lines = delta === 0 ? `${after} lines` : `${after} lines (${delta > 0 ? "+" : ""}${delta})`;
  const bytes = new TextEncoder().encode(draft).length;
  const state = draft === original ? "saved" : "unsaved draft";
  return `${lines} · ${bytes.toLocaleString()} bytes · ${state}`;
}
