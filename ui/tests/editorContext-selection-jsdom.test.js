// Checkpoint 9 (Phase 3P) — the Files-surface share action with a REAL
// CodeMirror view. Proves that a live selection becomes a bounded line range,
// that the current unsaved draft is the source, and that no selection shares
// the whole current buffer.
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
const outdir = join(uiDir, "..", ".tmp", "cp9-editor-context-selection");
const outfile = join(outdir, "bundle.cjs");

let bundleMod = null;

globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const tauriStub = {
  name: "tauri-stub",
  setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/]tauri\.tsx?$/ }, () => ({
      loader: "ts",
      contents: `
export const cmd = new Proxy({}, {
  get: (_target, prop) => (...args) => {
    const name = String(prop);
    if (name === "tree") return Promise.resolve({ path: args[0] ?? "", entries: [] });
    if (name === "fileText") return Promise.resolve({ path: args[0], content: "", bytes: 0 });
    if (name === "filePreview") return Promise.resolve({ path: args[0], content: "", offset: 0, line_limit: 200, size_bytes: 0, has_more: false });
    return Promise.resolve(null);
  },
});
export const listen = () => Promise.resolve(() => {});
`.trim(),
    }));
  },
};

const entry = `
import { options } from "preact";
options.debounceRendering = (fn) => fn();
export { FileTree } from "./src/components/FileTree.tsx";
export { getState, setState } from "./src/store.ts";
export { h, render } from "preact";
export async function findView(dom) {
  const { EditorView } = await import("@codemirror/view");
  return EditorView.findFromDOM(dom);
}
`.trim();

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
    plugins: [tauriStub],
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"test"' },
    logLevel: "silent",
  });
  bundleMod = createRequire(import.meta.url)(outfile);
  return bundleMod;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(desc, cond, timeoutMs = 4000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      await cond();
      return;
    } catch (error) {
      last = error;
    }
    await sleep(25);
  }
  throw new Error(`condition not met within ${timeoutMs}ms: ${desc}${last ? ` — ${String(last)}` : ""}`);
}

const withDom = async (run) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const previous = {};
  for (const key of ["document", "window", "MutationObserver", "Range", "InputEvent", "Selection",
    "KeyboardEvent", "MouseEvent", "CustomEvent", "Element", "Node", "HTMLElement", "CharacterData",
    "Text", "DOMParser", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle",
    "CSSStyleDeclaration", "location", "Window"]) {
    try {
      previous[key] = globalThis[key];
      globalThis[key] = dom.window[key];
    } catch {
      previous[key] = undefined;
    }
  }
  globalThis.window = dom.window;
  // jsdom has no layout engine. CodeMirror asks a Range for client rects when
  // drawing a selection; an empty rect list is the same accommodation the
  // editor's own jsdom tests need, and it does not affect selection offsets.
  dom.window.Range.prototype.getClientRects = function getClientRects() { return []; };
  dom.window.Range.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 };
  };
  try {
    await run(dom);
  } finally {
    try { bundleMod?.render(null, dom.window.document.body); } catch { /* detached */ }
    await sleep(60);
    try { bundleMod?.render(null, dom.window.document.body); } catch { /* already detached */ }
    await sleep(30);
    dom.window.document.body.innerHTML = "";
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete globalThis[key];
      else globalThis[key] = previous[key];
    }
  }
};

const q = (selector) => globalThis.document.querySelector(selector);
const qa = (selector) => [...globalThis.document.querySelectorAll(selector)];
const buttonByLabel = (label) => qa("button").find((button) => button.getAttribute("aria-label") === label);

const mount = async (bundle, docs) => {
  bundle.setState({
    view: "files",
    activeWorkspace: "ws-1",
    activeWorkspacePath: "C:/ws",
    editorWorkspaceTag: "C:/ws",
    editorDocs: docs,
    editorActivePath: docs[0].path,
    editorContexts: [],
    agentChanges: [],
    agentChangeTick: 0,
    tasks: [],
    workspaces: [],
    toasts: [],
    settings: null,
    diffEntry: null,
  });
  bundle.render(bundle.h(bundle.FileTree, null), globalThis.document.body);
  await until("editor mounted", () => {
    assert.ok(q(`.doc-editor[data-doc-path="${docs[0].path}"] .cm-content`));
    assert.ok(buttonByLabel(`Share ${docs[0].path} with agent`));
  });
};

test("a selected range is shared with exact line metadata from the unsaved draft", async () => {
  const bundle = await loadBundle();
  await withDom(async () => {
    const docs = [{ path: "src/app.ts", original: "old first\nold second\n", draft: "first\nsecond\nthird\n" }];
    await mount(bundle, docs);
    const cm = q('.doc-editor[data-doc-path="src/app.ts"] .cm-editor');
    const view = await bundle.findView(cm);
    assert.ok(view, "CodeMirror view found through the DOM");
    const selected = "first\nsecond\n";
    view.dispatch({ selection: { anchor: 0, head: selected.length } });
    assert.equal(view.state.sliceDoc(0, selected.length), selected);

    buttonByLabel("Share src/app.ts with agent").click();
    await until("one editor context stored", () => assert.equal(bundle.getState().editorContexts.length, 1));
    const [item] = bundle.getState().editorContexts;
    assert.equal(item.path, "src/app.ts");
    assert.equal(item.source, "selection");
    assert.equal(item.text, selected);
    assert.equal(item.startLine, 1);
    assert.equal(item.endLine, 2);
    assert.equal(item.totalLines, 4);
    assert.equal(item.unsaved, true, "the unsaved draft, not the disk baseline, was captured");
    assert.equal(bundle.getState().view, "chat", "the composer surface is brought forward for review");
  });
});

test("no selection shares the whole current buffer instead of an empty range", async () => {
  const bundle = await loadBundle();
  await withDom(async () => {
    const docs = [{ path: "notes.md", original: "disk\n", draft: "draft line one\ndraft line two\n" }];
    await mount(bundle, docs);
    const cm = q('.doc-editor[data-doc-path="notes.md"] .cm-editor');
    const view = await bundle.findView(cm);
    assert.ok(view);
    view.dispatch({ selection: { anchor: 2, head: 2 } });

    buttonByLabel("Share notes.md with agent").click();
    await until("whole file stored", () => assert.equal(bundle.getState().editorContexts.length, 1));
    const [item] = bundle.getState().editorContexts;
    assert.equal(item.source, "file");
    assert.equal(item.text, "draft line one\ndraft line two\n");
    assert.equal(item.startLine, 1);
    assert.equal(item.endLine, 3);
    assert.equal(item.unsaved, true);
  });
});
