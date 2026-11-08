// Frontend contract tests for the Step 3 context summary/veto helpers.
// The TypeScript module is transformed with the project's own esbuild (same
// approach as provider-status.test.js), so no extra dependency is added.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { transformSync } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../src/contextPreview.ts"), "utf8");
const { code } = transformSync(source, { loader: "ts", format: "cjs" });
const mod = { exports: {} };
new Function("module", "exports", code)(mod, mod.exports);
const { formatBytes, contextSummary, contextRows, contextCaveat } = mod.exports;

function preview(extra = {}) {
  return {
    enabled: true,
    budget_bytes: 24576,
    bytes: 2048,
    considered: 40,
    truncated: false,
    scan_capped: false,
    omitted: 0,
    excluded_by_user: 0,
    skipped: { binary: 0, oversized: 0, unreadable: 0, outside: 0 },
    files: [
      { path: "src/auth.rs", start_line: 1, end_line: 40, bytes: 1024 },
      { path: "src/store.ts", start_line: 12, end_line: 30, bytes: 1024 },
    ],
    ...extra,
  };
}

test("formatBytes uses B/KB/MB thresholds", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(999), "999 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(24576), "24.0 KB");
  assert.equal(formatBytes(2 * 1024 * 1024), "2.0 MB");
});

test("summary names the included files and the share of the budget", () => {
  assert.equal(
    contextSummary(preview()),
    "Project context · 2 files · 2.0 KB of 24.0 KB",
  );
  const one = preview({ files: [{ path: "a.rs", start_line: 1, end_line: 1, bytes: 10 }] });
  assert.match(contextSummary(one), /^Project context · 1 file · /);
});

test("summary is honest when nothing matched or the scan was skipped", () => {
  assert.equal(
    contextSummary(preview({ files: [], considered: 12 })),
    "Project context · no matching files · 12 scanned",
  );
  assert.equal(contextSummary(null), "Project context · checking…");
  assert.equal(contextSummary(preview(), false), "Project context off");
  assert.equal(
    contextSummary(preview({ enabled: false })),
    "Project context off (disabled in Settings)",
  );
});

test("summary and caveat report truncation, omissions and skips", () => {
  const p = preview({
    truncated: true,
    omitted: 3,
    scan_capped: true,
    skipped: { binary: 2, oversized: 1, unreadable: 0, outside: 1 },
    excluded_by_user: 1,
  });
  assert.match(contextSummary(p), /truncated$/);
  assert.equal(
    contextCaveat(p),
    "3 matching file(s) omitted for budget · workspace scan limit reached · skipped 2 binary, 1 oversized, 1 outside workspace · 1 excluded by you",
  );
  assert.equal(contextCaveat(preview()), "");
});

test("veto rows keep a removed file visible and unchecked", () => {
  const rows = contextRows(preview(), ["src/store.ts"]);
  assert.deepEqual(rows.map((r) => [r.path, r.checked]), [
    ["src/auth.rs", true],
    ["src/store.ts", false],
  ]);
  assert.equal(rows[0].detail, "lines 1–40 · 1.0 KB");

  const extra = contextRows(preview(), ["src/gone.rs"]);
  assert.equal(extra.length, 3);
  assert.equal(extra[2].checked, false);
  assert.equal(extra[2].detail, "excluded for this task");
});
