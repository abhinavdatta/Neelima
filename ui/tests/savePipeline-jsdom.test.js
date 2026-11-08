// FAILED-SAVE integral pipeline test (Checkpoint 3 closeout).
//
// This is not a pure-function test: it bundles the real FileTree, DiffModal,
// NativeEditor and store (preact + CodeMirror) with esbuild, mounts them in
// jsdom with a stubbed Tauri command layer, and drives the REAL user path:
//
//   draft dirty → "Review & save" → DiffModal opens → "Apply change"
//   → cmd.fileSave REJECTS → modal stays open for retry, an error toast is
//   raised, and the document keeps its dirty draft (no state cleared),
//   → Cancel closes the modal with the draft intact and without a second
//   write attempt,
//   → a retry whose fileSave RESOLVES clears dirty for exactly that document
//   (path-routed) and leaves every other open document untouched.
//
// The backend stub never writes to disk; the failed save is enforced by the
// stub rejecting, which is the identical code path the Rust command takes
// (it rejects the invoke promise the UI awaits).
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
const repoDir = join(uiDir, "..");
const outdir = join(repoDir, ".tmp", "p3q2-save-pipeline");
const outfile = join(outdir, "bundle.cjs");

// ── Bundle once per process: real components, stubbed Tauri layer ──────────
let bundleMod = null;

const tauriStubLoader = {
  name: "tauri-stub",
  setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/]tauri\.tsx?$/ }, () => ({
      loader: "ts",
      contents: `
const g = globalThis;
g.__pipeStub = g.__pipeStub ?? {
  calls: [],
  fileSave: async () => { throw new Error("stub fileSave not configured"); },
};
const record = (name, args) => { g.__pipeStub.calls.push({ name, args }); };
export const cmd = new Proxy({}, {
  get: (_t, prop) => (...args) => {
    record(String(prop), args);
    if (String(prop) === "fileSave") { return g.__pipeStub.fileSave(...args); }
    if (String(prop) === "tree") { return Promise.resolve({ path: args[0] ?? "", entries: [] }); }
    if (String(prop) === "fileText") { return g.__pipeStub.fileText ? g.__pipeStub.fileText(...args) : Promise.resolve({ path: args[0], content: "", bytes: 0 }); }
    if (String(prop) === "filePreview") { return Promise.resolve({ path: args[0], content: "", offset: 0, line_limit: 200, size_bytes: 0, has_more: false }); }
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
// jsdom's rAF loop cannot be relied on under CodeMirror's measurement loop,
// so component updates are flushed synchronously in this test.
options.debounceRendering = (fn) => fn();
export { FileTree } from "./src/components/FileTree.tsx";
export { DiffModal } from "./src/components/DiffModal.tsx";
export { getState, setState, toast } from "./src/store.ts";
export { h, Fragment, render } from "preact";
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
    plugins: [tauriStubLoader],
    define: { "process.env.NODE_ENV": '"test"' },
    logLevel: "silent",
  });
  const req = createRequire(import.meta.url);
  bundleMod = req(outfile);
  return bundleMod;
}

// ── jsdom (CodeMirror needs several window/document globals) ───────────────
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
      previous[key] = undefined; // read-only host global (navigator): borrow skipped
    }
  }
  globalThis.window = dom.window;
  try {
    await run(dom);
  } finally {
    // Unmount while this window's globals are still installed. Clearing the
    // body alone leaves Preact components mounted and subscribed to the
    // module-level store, and CodeMirror keeps measurement timers alive; both
    // would later run after `document`/`window` are restored and turn into
    // unhandled errors that fail the whole file.
    try { bundleMod?.render(null, dom.window.document.body); } catch { /* not mounted */ }
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Polled assertions for async component effects (MergeView loads, apply promise).
async function until(desc, cond, timeoutMs = 2500) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      await cond();
      return;
    } catch (e) {
      last = e;
    }
    await sleep(30);
  }
  throw new Error(`condition not met within ${timeoutMs}ms: ${desc}${last ? ` — ${String(last)}` : ""}`);
}const q = (sel) => globalThis.document.querySelector(sel);
const qa = (sel) => [...globalThis.document.querySelectorAll(sel)];
const clickByClass = (sel) => {
  const el = q(sel);
  assert.ok(el, `expected element ${sel}`);
  el.click();
};

// Scenario state shared across the flow inside one test:
const ORIGINAL_NOTES = "# scratch notes";
const DRAFT_NOTES = "V1 # scratch notes";

test("failed ui_file_save keeps the draft dirty and the review open; retry clears dirty for exactly that document", async () => {
  await withDom(async () => {
    const { FileTree, DiffModal, getState, setState, h, Fragment, render } = await loadBundle();
    const stub = globalThis.__pipeStub;
    assert.ok(stub, "tauri stub installed by bundle");

    setState({
      activeWorkspacePath: "C:/ws",
      editorWorkspaceTag: "C:/ws",
      editorDocs: [
        { path: "notes.md", original: ORIGINAL_NOTES, draft: DRAFT_NOTES }, // dirty
        { path: "sub/gamma.txt", original: "gamma", draft: "gamma" },      // clean
      ],
      editorActivePath: "notes.md",
      diffEntry: null,
      toasts: [],
    });

    // Mount exactly once, like the app. Re-rendering a fresh root vnode into
    // document.body appends a second tree under jsdom (Preact cannot re-use
    // the root here), which would double every mounted component; store
    // updates already render synchronously in this bundle, so no manual flush
    // is needed and the assertions below poll the real DOM.
    render(h(Fragment, null, h(FileTree, null), h(DiffModal, null)), globalThis.document.body);

    await until("editors mounted with two tabs", () => {
      assert.equal(qa(".editor-tab").length, 2);
      assert.ok(q(".fw-editor"), "editor surface present");
    });
    // Preact flushes mount effects (the store subscriptions) on a 35 ms timer
    // plus rAF; wait for that so store updates repaint the mounted tree.
    await sleep(80);

    const buttons = () => qa("button").map((b) => b.textContent.trim());
    const findBtn = (text) => qa("button").find((b) => b.textContent.trim().includes(text));

    // ── open the review gate for the dirty document ─────────────────────
    const rev = findBtn("Review & save");
    rev.click();
    await until("DiffModal is open for notes.md", () => {
      assert.ok(q(".modal-backdrop"), "modal backdrop present");
      assert.ok(q(".diff-modal"), "modal present");
      assert.equal(q(".diff-path")?.textContent, "notes.md");
    });

    // ── apply with a REJECTING backend save ─────────────────────────────
    stub.calls.length = 0;
    stub.fileSave = async () => {
      throw new Error("EPERM: permission denied, write notes.md");
    };
    findBtn("Apply").click();
    await sleep(30); // apply()'s rejected promise settles async

    await until("the failed save surfaced as an error toast", () => {
      const errs = getState().toasts.filter((t) => t.level === "error");
      assert.ok(errs.some((t) => t.text.includes("EPERM")), `error toast shown: ${getState().toasts.map((t) => t.text)}`);
    });

    // Contract 1: failed save must NOT clear dirty or drop the draft.
    await until("diffEntry stays open for retry", () => {
      assert.ok(getState().diffEntry?.preview, "review stays open so the user can retry");
      assert.ok(q(".modal-backdrop"), "modal is still on screen after the failure");
    });
    let docs = getState().editorDocs;
    assert.equal(docs.find((d) => d.path === "notes.md")?.original, ORIGINAL_NOTES, "base unchanged after failed save");
    assert.equal(docs.find((d) => d.path === "notes.md")?.draft, DRAFT_NOTES, "draft preserved after failed save");
    assert.equal(qa(".editor-tab").length, 2, "no tabs lost");
    const notesTabStillDirty = qa(".editor-tab").some(
      (t) => (t.querySelector(".editor-tab-name")?.textContent) === "notes.md"
        && t.classList.contains("editor-tab-dirty"),
    );
    assert.ok(notesTabStillDirty, "tab still marked dirty after failed save");

    // Exactly one ui_file_save was attempted, with the DRAFT it reviewed and
    // the exact baseline that diff was computed against (Checkpoint 4).
    assert.equal(stub.calls.filter((c) => c.name === "fileSave").length, 1);
    assert.deepEqual(stub.calls.find((c) => c.name === "fileSave").args, ["notes.md", DRAFT_NOTES, ORIGINAL_NOTES]);

    // Contract 2: cancelling the retry must still keep the draft, and must
    // never attempt a second write behind the user's back.
    findBtn("Cancel").click();
    // Allow the click to flush; then verify no further writes occurred.
    let callsAfterCancel = stub.calls.filter((c) => c.name === "fileSave").length;
    assert.equal(callsAfterCancel, 1, "cancel never invokes fileSave");
    docs = getState().editorDocs;
    assert.equal(docs.find((d) => d.path === "notes.md")?.draft, DRAFT_NOTES, "draft survives cancel-after-failure");
    assert.equal(docs.find((d) => d.path === "notes.md")?.original, ORIGINAL_NOTES, "base survives cancel-after-failure");
    assert.ok(getState().diffEntry === null, "closing the diff clears the review state");
    assert.equal(qa(".editor-tab").length, 2, "tab still open after review cancel");

    // ── retry with a SUCCEEDING backend save ────────────────────────────
    stub.fileSave = async () => ({ path: "notes.md", bytes: 123, lines: 4 });
    const review = findBtn("Review & save");
    assert.ok(review, "Review & save re-enabled because the doc is still dirty");
    review.click();
    await until("review open again", () => {
      assert.equal(q(".diff-path")?.textContent, "notes.md");
    });
    const callsBeforeSuccess = stub.calls.filter((c) => c.name === "fileSave").length;
    findBtn("Apply").click();
    await sleep(30);
    await until("apply resolves and the modal closes", () => {
      assert.equal(getState().diffEntry, null);
      assert.equal(q(".modal-backdrop"), null);
    });
    assert.equal(stub.calls.filter((c) => c.name === "fileSave").length, callsBeforeSuccess + 1);

    // Contract 3: success clears dirty for EXACTLY the saved document.
    docs = getState().editorDocs;
    const notes = docs.find((d) => d.path === "notes.md");
    const gamma = docs.find((d) => d.path === "sub/gamma.txt");
    assert.equal(notes.draft, DRAFT_NOTES, "saved snapshot is the new draft");
    assert.equal(notes.original, DRAFT_NOTES, "saved snapshot is the new clean base");
    assert.equal(gamma.original, "gamma");
    assert.equal(gamma.draft, "gamma", "the other tab was never touched by either attempt");
    assert.ok(getState().toasts.some((t) => t.level === "info" && t.text.includes("Saved notes.md")));
    // CP10 integration defect: the footer is a rendered projection of the SAME
    // structural dirty rule, so a successful save must stop saying "unsaved
    // draft" immediately (not only after a tab switch/remount).
    const footerText = q(".file-preview-foot")?.textContent ?? "";
    assert.match(footerText, /saved/, `footer reports the saved state: ${footerText}`);
    assert.doesNotMatch(footerText, /unsaved draft/, "a saved document is not labelled as an unsaved draft");
  });
});

// Checkpoint 4 (Phase 3P): the Rust save command verifies an externally
// modified file and refuses with a CONFLICT:: marker. These tests exercise
// the FRONTEND response to that refusal (the Rust behavior itself has its own
// cargo tests; a stub here does not verify the backend).
test("external-modification conflict keeps the review open, rebases the diff onto the latest disk contents, and preserves the draft", async () => {
  const DISK_LATEST = "v2-external from another process\n";
  await withDom(async () => {
    const { FileTree, DiffModal, getState, setState, h, Fragment, render } = await loadBundle();
    const stub = globalThis.__pipeStub;
    assert.ok(stub);

    setState({
      activeWorkspacePath: "C:/ws",
      editorWorkspaceTag: "C:/ws",
      editorDocs: [
        { path: "notes.md", original: ORIGINAL_NOTES, draft: DRAFT_NOTES }, // dirty
        { path: "sub/gamma.txt", original: "gamma", draft: "gamma" },      // clean
      ],
      editorActivePath: "notes.md",
      diffEntry: null,
      toasts: [],
    });
    render(h(Fragment, null, h(FileTree, null), h(DiffModal, null)), globalThis.document.body);
    await until("editors mounted with two tabs", () => {
      assert.equal(qa(".editor-tab").length, 2);
    });
    await sleep(80); // let mount effects (store subscriptions) flush
    const findBtn = (text) => qa("button").find((b) => b.textContent.trim().includes(text));

    findBtn("Review & save").click();
    await until("review open", () => {
      assert.equal(q(".diff-path")?.textContent, "notes.md");
    });

    // The backend refuses because the on-disk file no longer matches the
    // reviewed baseline; a reload of the file returns the newest bytes.
    stub.calls.length = 0;
    let fileSaveCalls = 0;
    stub.fileText = async (path) => {
      assert.equal(path, "notes.md");
      return { path, content: DISK_LATEST, bytes: DISK_LATEST.length };
    };
    stub.fileSave = async () => {
      fileSaveCalls += 1;
      throw new Error(
        "CONFLICT::notes.md changed on disk since it was opened, so applying the review would silently overwrite external changes. Reload the file and review again against the latest contents.",
      );
    };
    findBtn("Apply").click();
    await sleep(30);

    // Contract C1: the refusal is surfaced as a conflict error, the review
    // stays open, and the diff NOW COMPARES the draft against the LATEST
    // disk contents (the rebase), ready for a fresh read-through.
    await until("conflict surfaced and diff rebased", () => {
      assert.ok(getState().toasts.some((t) => t.level === "error" && t.text.includes("changed on disk since review started")));
      assert.ok(q(".modal-backdrop"), "review stays open after the conflict");
      assert.equal(getState().diffEntry?.preview?.old, DISK_LATEST, "diff base is the latest disk content");
      assert.equal(getState().diffEntry?.preview?.new, DRAFT_NOTES, "the reviewed draft is unchanged");
    });
    // The document keeps its draft; only its diff base moved to the newest
    // disk text. Dirty stays structural (draft !== rebased original).
    let docs = getState().editorDocs;
    assert.equal(docs.find((d) => d.path === "notes.md")?.original, DISK_LATEST, "baseline rebased onto the latest disk content");
    assert.equal(docs.find((d) => d.path === "notes.md")?.draft, DRAFT_NOTES, "draft (unsaved work) fully preserved");
    assert.equal(docs.find((d) => d.path === "sub/gamma.txt")?.original, "gamma", "the other document was never touched");
    // Exactly ONE write was attempted, with the reviewed draft and the stale
    // baseline — and the reload fetched the latest contents exactly once.
    assert.equal(fileSaveCalls, 1, "no duplicate save attempts, no silent overwrite");
    assert.deepEqual(
      stub.calls.find((c) => c.name === "fileSave")?.args,
      ["notes.md", DRAFT_NOTES, ORIGINAL_NOTES],
    );
    assert.equal(stub.calls.filter((c) => c.name === "fileText").length, 1, "one reload to rebase");

    // Contract C2: applying the SAME reviewed draft again now validates
    // against the RELOADED baseline and succeeds; success clears dirty for
    // exactly the saved document.
    stub.fileSave = async () => ({ path: "notes.md", bytes: 9, lines: 1 });
    findBtn("Apply").click();
    await sleep(30);
    await until("conflict-resolved retry succeeds", () => {
      assert.equal(getState().diffEntry, null);
      assert.equal(q(".modal-backdrop"), null);
    });
    assert.equal(fileSaveCalls, 1, "still no phantom attempts");
    assert.deepEqual(
      stub.calls.filter((c) => c.name === "fileSave").pop()?.args,
      ["notes.md", DRAFT_NOTES, DISK_LATEST],
      "the retry validates the draft against the RELOADED baseline",
    );
    docs = getState().editorDocs;
    const notes = docs.find((d) => d.path === "notes.md");
    const gamma = docs.find((d) => d.path === "sub/gamma.txt");
    assert.equal(notes.draft, DRAFT_NOTES);
    assert.equal(notes.original, DRAFT_NOTES, "new clean base is the saved draft");
    assert.equal(gamma.original, "gamma");
    assert.equal(gamma.draft, "gamma", "the other tab was never cleared");
    assert.ok(getState().toasts.some((t) => t.level === "info" && t.text.includes("Saved notes.md")));
  });
});

test("missing destination failure keeps the review available, the draft dirty, and never fakes success", async () => {
  await withDom(async () => {
    const { FileTree, DiffModal, getState, setState, h, Fragment, render } = await loadBundle();
    const stub = globalThis.__pipeStub;
    assert.ok(stub);

    setState({
      activeWorkspacePath: "C:/ws",
      editorWorkspaceTag: "C:/ws",
      editorDocs: [{ path: "notes.md", original: ORIGINAL_NOTES, draft: DRAFT_NOTES }],
      editorActivePath: "notes.md",
      diffEntry: null,
      toasts: [],
    });
    render(h(Fragment, null, h(FileTree, null), h(DiffModal, null)), globalThis.document.body);
    await until("editor mounted", () => {
      assert.equal(qa(".editor-tab").length, 1);
    });
    await sleep(80); // let mount effects (store subscriptions) flush
    const findBtn = (text) => qa("button").find((b) => b.textContent.trim().includes(text));

    findBtn("Review & save").click();
    await until("review open", () => {
      assert.equal(q(".diff-path")?.textContent, "notes.md");
    });

    stub.calls.length = 0;
    stub.fileSave = async () => {
      throw new Error("Could not inspect file: the file was moved or deleted");
    };
    findBtn("Apply").click();
    await sleep(30);

    await until("missing destination surfaced", () => {
      assert.ok(getState().toasts.some((t) => t.level === "error" && t.text.includes("Could not inspect file")));
      assert.ok(q(".modal-backdrop"), "review stays open");
    });
    const docs = getState().editorDocs;
    assert.equal(docs.find((d) => d.path === "notes.md")?.draft, DRAFT_NOTES, "draft preserved");
    assert.equal(docs.find((d) => d.path === "notes.md")?.original, ORIGINAL_NOTES, "baseline preserved");
    assert.equal(stub.calls.filter((c) => c.name === "fileSave").length, 1, "exactly one attempt");
    assert.equal(getState().toasts.filter((t) => t.level === "info" && t.text.includes("Saved")).length, 0, "no false success toast");
  });
});

// Checkpoint 6 closeout: cancelling a PENDING review (before any apply) is a
// distinct lifecycle from cancel-after-failure. It must never reach the save
// command and must leave the draft and its exact review baseline untouched.
test("cancelling a pending review invokes no save and preserves the draft and baseline", async () => {
  await withDom(async () => {
    const { FileTree, DiffModal, getState, setState, h, Fragment, render } = await loadBundle();
    const stub = globalThis.__pipeStub;
    stub.calls.length = 0;
    setState({
      activeWorkspacePath: "C:/ws",
      editorWorkspaceTag: "C:/ws",
      editorDocs: [{ path: "notes.md", original: ORIGINAL_NOTES, draft: DRAFT_NOTES }],
      editorActivePath: "notes.md",
      diffEntry: null,
      toasts: [],
    });
    render(h(Fragment, null, h(FileTree, null), h(DiffModal, null)), globalThis.document.body);
    await until("one mounted tab", () => assert.equal(qa(".editor-tab").length, 1));
    await sleep(80);

    const findBtn = (text) => qa("button").find((b) => b.textContent.trim().includes(text));
    const review = findBtn("Review & save");
    assert.ok(review, "Review & save is available for the dirty draft");
    review.click();
    await until("pending review open", () => assert.equal(q(".diff-path")?.textContent, "notes.md"));
    const cancel = findBtn("Cancel");
    assert.ok(cancel, "the review offers an explicit Cancel");
    assert.equal(stub.calls.filter((c) => c.name === "fileSave").length, 0, "opening a review writes nothing");

    cancel.click();
    await until("review closed", () => assert.equal(getState().diffEntry, null));
    assert.equal(q(".modal-backdrop"), null);
    assert.equal(
      stub.calls.filter((c) => c.name === "fileSave").length,
      0,
      "cancelling a pending review never invokes ui_file_save",
    );
    const doc = getState().editorDocs[0];
    assert.equal(doc.draft, DRAFT_NOTES, "the unsaved draft survives cancel");
    assert.equal(doc.original, ORIGINAL_NOTES, "the review baseline is unchanged");
    assert.equal(qa(".editor-tab").length, 1, "the tab remains open and editable");
    assert.equal(
      getState().toasts.filter((t) => t.level === "error").length,
      0,
      "a deliberate cancel is not reported as a failure",
    );
  });
});
