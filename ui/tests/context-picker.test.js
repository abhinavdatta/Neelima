// Frontend rendering test for the Step 3 context inspector: the panel must show
// the backend's real selection, allow a per-file veto, and never imply that
// unlisted files are sent. Bundled with the project's own esbuild and rendered
// with Preact into jsdom (same approach as provider-wait-card.test.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { buildSync } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;

const build = buildSync({
  stdin: {
    contents: `
      import { render, h } from "preact";
      import { ContextPicker } from "./src/components/ContextPicker.tsx";
      export { render, h, ContextPicker };
    `,
    resolveDir: join(here, ".."),
    sourcefile: "context-picker-entry.tsx",
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "browser",
  jsx: "automatic",
  jsxImportSource: "preact",
  define: { "process.env.NODE_ENV": '"test"' },
  logLevel: "silent",
});

const bundle = build.outputFiles[0].text;
const mod = { exports: {} };
new Function("module", "exports", "require", bundle)(mod, mod.exports, require);
const { render, h, ContextPicker } = mod.exports;

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

const preview = {
  enabled: true,
  budget_bytes: 24576,
  bytes: 2048,
  considered: 40,
  truncated: true,
  scan_capped: false,
  omitted: 2,
  excluded_by_user: 0,
  skipped: { binary: 1, oversized: 0, unreadable: 0, outside: 0 },
  files: [
    { path: "src/auth.rs", start_line: 1, end_line: 40, bytes: 1024 },
    { path: "src/store.ts", start_line: 12, end_line: 30, bytes: 1024 },
  ],
};

test("the panel shows the real selection, truncation and budgets", async () => {
  const root = document.getElementById("root");
  render(h(ContextPicker, {
    enabled: true,
    preview,
    scanning: false,
    excluded: [],
    workspaceReady: true,
    budgets: { web_budget_tokens: 6000, local_budget_tokens: 2500, max_files: 12 },
    onToggle: () => {},
    onExclude: () => {},
  }), root);
  await tick();
  try {
    const text = root.textContent;
    assert.match(text, /Project context · 2 files · 2\.0 KB of 24\.0 KB · truncated/);
    assert.match(text, /src\/auth\.rs/);
    assert.match(text, /lines 1–40 · 1\.0 KB/);
    assert.match(text, /2 matching file\(s\) omitted for budget/);
    assert.match(text, /skipped 1 binary/);
    assert.match(text, /6000 tokens for browser providers/);
    const boxes = root.querySelectorAll("input[type=checkbox]");
    assert.equal(boxes.length, 3, "one attach toggle plus one row per file");
    assert.equal(boxes[1].checked, true);
  } finally {
    render(null, root);
    await tick();
  }
});

test("vetoing a file reports the path and keeps it visible", async () => {
  const root = document.getElementById("root");
  const calls = [];
  render(h(ContextPicker, {
    enabled: true,
    preview,
    scanning: false,
    excluded: [],
    workspaceReady: true,
    budgets: null,
    onToggle: (next) => calls.push(["toggle", next]),
    onExclude: (path, include) => calls.push(["exclude", path, include]),
  }), root);
  await tick();
  try {
    const row = root.querySelector('input[data-context-path="src/store.ts"]');
    assert.ok(row, "second file row exists");
    row.checked = false;
    row.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await tick();
    assert.deepEqual(calls, [["exclude", "src/store.ts", false]]);
  } finally {
    render(null, root);
    await tick();
  }
});

test("idle and no-workspace states are labelled honestly", async () => {
  const root = document.getElementById("root");
  const base = {
    enabled: true,
    preview: null,
    scanning: false,
    excluded: [],
    workspaceReady: true,
    budgets: null,
    onToggle: () => {},
    onExclude: () => {},
  };
  render(h(ContextPicker, base), root);
  await tick();
  try {
    assert.match(root.textContent, /Project context · waiting for a prompt/);
    assert.doesNotMatch(root.textContent, /checking…/);
    render(h(ContextPicker, { ...base, workspaceReady: false }), root);
    await tick();
    assert.match(root.textContent, /Project context · no workspace/);
    assert.match(root.textContent, /Choose a project folder/);
  } finally {
    render(null, root);
    await tick();
  }
});

test("a disabled panel says so and lists nothing", async () => {
  const root = document.getElementById("root");
  render(h(ContextPicker, {
    enabled: false,
    preview,
    scanning: false,
    excluded: [],
    workspaceReady: true,
    budgets: null,
    onToggle: () => {},
    onExclude: () => {},
  }), root);
  await tick();
  try {
    assert.match(root.textContent, /Project context off/);
    assert.doesNotMatch(root.textContent, /src\/auth\.rs/);
    assert.equal(root.querySelectorAll("input[data-context-path]").length, 0);
  } finally {
    render(null, root);
    await tick();
  }
});
