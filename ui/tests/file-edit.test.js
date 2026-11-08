// Guards for the native code editor save flow (ui/src/fileEdit.ts).
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { transformSync } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../src/fileEdit.ts"), "utf8");
const { code } = transformSync(source, { loader: "ts", format: "cjs" });
const mod = { exports: {} };
new Function("module", "exports", code)(mod, mod.exports);
const { editBlockReason, editStatus, EDIT_MAX_BYTES } = mod.exports;

test("an untouched draft cannot be saved", () => {
  assert.equal(editBlockReason("a\nb\n", "a\nb\n"), "No changes to save");
});

test("a whitespace-only change is still a real change", () => {
  assert.equal(editBlockReason("a\nb\n", "a\nb\n\n"), null);
  assert.equal(editBlockReason("a\r\nb\r\n", "a\nb\n"), null);
});

test("oversized drafts are blocked with the limit in the message", () => {
  const reason = editBlockReason("", "x".repeat(EDIT_MAX_BYTES + 1));
  assert.match(reason, /limited to 1024 KB/);
  assert.equal(editBlockReason("", "x".repeat(EDIT_MAX_BYTES)), null);
});

test("status reports line delta and byte size, and only calls a changed draft unsaved", () => {
  assert.equal(editStatus("a\nb", "a\nb"), "2 lines · 3 bytes · saved");
  assert.equal(editStatus("a\nb", "a\nb\n"), "3 lines (+1) · 4 bytes · unsaved draft");
  assert.match(editStatus("a", "a\nb\nc"), /^3 lines \(\+2\)/);
  assert.match(editStatus("a\nb\nc", "a"), /^1 lines \(-2\)/);
});
