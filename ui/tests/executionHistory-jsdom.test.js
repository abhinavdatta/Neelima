// CP8 mounted execution-history panel: real component + real store, no Tauri
// calls. The transcript fixtures mirror the Rust CallRecord JSON shape.
import test from "node:test";
import assert from "node:assert/strict";
import esbuild from "esbuild";
import { JSDOM } from "jsdom";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const uiDir = join(here, "..");
const outdir = join(uiDir, "..", ".tmp", "cp8-execution-panel");
const outfile = join(outdir, "bundle.cjs");

let bundleMod = null;
const mounted = [];

// Preact's after-paint effect queue schedules a 35 ms fallback timer whose
// callback calls the *global* cancelAnimationFrame. Keep these stubs installed
// for the whole test process so a timer cannot fire after the DOM teardown.
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
const persistentGlobals = new Set(["requestAnimationFrame", "cancelAnimationFrame"]);

const entry = `
import { options } from "preact";
options.debounceRendering = (fn) => fn();
export { ExecutionHistory } from "./src/components/ExecutionHistory.tsx";
export { getState, setState } from "./src/store.ts";
export { h, render } from "preact";
`;

async function loadBundle() {
  if (bundleMod) return bundleMod;
  mkdirSync(outdir, { recursive: true });
  await esbuild.build({
    stdin: { contents: entry, loader: "js", resolveDir: uiDir },
    absWorkingDir: uiDir,
    tsconfig: join(uiDir, "tsconfig.json"),
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile,
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"test"' },
    logLevel: "silent",
  });
  bundleMod = createRequire(import.meta.url)(outfile);
  return bundleMod;
}

const qa = (selector) => [...globalThis.document.querySelectorAll(selector)];
const text = () => globalThis.document.body.textContent ?? "";

const withDom = async (run) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  // Deterministic RAF stubs: pretendToBeVisual starts a jsdom clock whose
  // timer can outlive the test and reference a restored global.
  dom.window.requestAnimationFrame = (cb) => dom.window.setTimeout(() => cb(Date.now()), 0);
  dom.window.cancelAnimationFrame = (id) => dom.window.clearTimeout(id);
  const previous = {};
  for (const key of ["document", "window", "Node", "Element", "HTMLElement", "getComputedStyle"]) {
    try {
      previous[key] = globalThis[key];
      globalThis[key] = dom.window[key];
    } catch {
      previous[key] = undefined;
    }
  }
  globalThis.window = dom.window;
  try {
    await run();
  } finally {
    for (const root of mounted.splice(0)) {
      try { bundleMod?.render(null, root); } catch { /* detached */ }
      root.remove();
    }
    dom.window.document.body.innerHTML = "";
    // Stop jsdom's pretendToBeVisual RAF loop before restoring globals;
    // otherwise it fires after cancelAnimationFrame is gone.
    dom.window.close();
    for (const key of Object.keys(previous)) {
      if (persistentGlobals.has(key)) continue;
      if (previous[key] === undefined) delete globalThis[key];
      else globalThis[key] = previous[key];
    }
  }
};

const task = {
  id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  title: "Run tests",
  started_ms: 1000,
  ended_ms: 2000,
  workspace: "C:/inamigos webdev",
  provider: "manual",
  status: "done",
  iterations: 2,
};

const call = (overrides = {}) => ({
  id: "c1",
  tool: "run_command",
  args: { command: "npm test" },
  status: "ok",
  output: "12 passing",
  action_id: "act-1234567890",
  started_ms: 1_700_000_000_000,
  duration_ms: 1250,
  exit_code: 0,
  ...overrides,
});

function renderWith(entries, overrides = {}) {
  const bundle = bundleMod;
  bundle.setState({
    entries,
    openTask: task,
    taskId: null,
    activeWorkspacePath: task.workspace,
    commandChunks: {},
    ...overrides,
  });
  const root = globalThis.document.createElement("div");
  globalThis.document.body.appendChild(root);
  mounted.push(root);
  bundle.render(bundle.h(bundle.ExecutionHistory, null), root);
}

test("renders persisted calls with task/workspace attribution, status, duration and exit code", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    renderWith([
      { id: 1, ts: 10, kind: "tool_calls", text: "", calls: [call()] },
      { id: 2, ts: 20, kind: "tool_calls", text: "", calls: [call({ id: "c2", tool: "read_file", args: { path: "src/main.rs" }, status: "error", output: "ENOENT", exit_code: null, duration_ms: null })] },
    ]);
    const panel = globalThis.document.querySelector('[data-testid="execution-history"]');
    assert.ok(panel, "panel mounted");
    assert.equal(qa(".exec-row").length, 2);
    assert.match(text(), /Run tests · C:\/inamigos webdev/);
    assert.match(text(), /npm test/);
    assert.match(text(), /12 passing/);
    assert.match(text(), /succeeded/);
    assert.match(text(), /failed/);
    assert.match(text(), /1\.3 s/);
    assert.match(text(), /exit 0/);
    assert.match(text(), /src\/main\.rs/);
    assert.match(text(), /Action: act-1234567890/);
    assert.equal(qa(".exec-summary .ok").length, 1);
    assert.equal(qa(".exec-summary .error").length, 1);
  });
});

test("all six persisted lifecycle statuses render with their own labels", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    const statuses = [
      ["s1", "ok", "succeeded"],
      ["s2", "error", "failed"],
      ["s3", "timed_out", "timed out"],
      ["s4", "cancelled", "cancelled"],
      ["s5", "refused", "refused"],
      ["s6", "rejected", "rejected"],
    ];
    renderWith([
      { id: 9, ts: 10, kind: "tool_calls", text: "", calls: statuses.map(([id, status]) => call({ id, status })) },
    ]);
    assert.equal(qa(".exec-row").length, 6);
    const rows = qa(".exec-row");
    statuses.forEach(([id, , label], index) => {
      assert.match(rows[index].textContent ?? "", new RegExp(`#${id}`));
      assert.match(rows[index].textContent ?? "", new RegExp(label));
    });
    assert.equal(qa(".exec-summary .ok").length, 1);
    assert.equal(qa(".exec-summary .error").length, 1);
    assert.equal(qa(".exec-summary .warn").length, 4, "timeout, cancel, refusal and rejection are distinct warnings");
  });
});

test("legacy records render without invented timing or exit metadata", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    renderWith([
      {
        id: 7,
        ts: 10,
        kind: "tool_calls",
        text: "",
        calls: [{ id: "old", tool: "write_file", args: { path: "a.txt" }, status: "ok", output: "written" }],
      },
    ]);
    assert.equal(qa(".exec-row").length, 1);
    assert.match(text(), /written/);
    assert.doesNotMatch(text(), /exit \d/);
    assert.doesNotMatch(text(), /Action:/);
  });
});

test("command output is rendered as text, never as markup", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    const hostile = '<img src=x onerror="globalThis.__cp8Xss=1"> <script>globalThis.__cp8Xss=2</script>';
    renderWith([
      { id: 8, ts: 10, kind: "tool_calls", text: "", calls: [call({ output: hostile })] },
    ]);
    assert.equal(qa("img, script").length, 0, "no element was created from output");
    assert.equal(globalThis.__cp8Xss, undefined, "no handler or script executed");
    assert.ok(text().includes('<img src=x onerror="globalThis.__cp8Xss=1">'), "the literal text is visible");
  });
});

test("an empty transcript has an honest empty state", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    renderWith([], { openTask: null, activeWorkspacePath: null, taskId: null });
    assert.equal(qa(".exec-row").length, 0);
    assert.match(text(), /No tool or command executions recorded/);
    assert.match(text(), /No task open/);
  });
});
