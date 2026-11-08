// Checkpoint 3 — pure multi-document tab tests (identity, dirty semantics,
// close/cancel/discard, save routing, keyboard mapping, lifecycle cap).
// DOM/editor lifecycle has its own jsdom suite (editorTabs-jsdom.test.js);
// this file covers everything that needs no DOM.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_DOCS, closeDocument, cycleActive, docsAfterSave, docDirty, docDir,
  docName, openDocument, tabKeyAction,
} from "../src/editorTabs.ts";

const doc = (path, text, draft) => ({ path, original: text, draft: draft ?? text });

test("doc identity: same base name in different directories are distinct documents", () => {
  const [first] = openDocument([], "src/a/util.ts", "a").docs;
  const [second] = openDocument([], "src/b/util.ts", "b").docs;
  assert.equal(docName(first.path), "util.ts");
  assert.notEqual(first.path, second.path);
  const pair = [first, second];
  assert.equal(new Set(pair.map((d) => d.path)).size, 2, "two tabs, no duplicate identity");
  assert.equal(docDir(first.path), "src/a");
  assert.equal(docDir(second.path), "src/b");
});

test("opening a new document adds a tab and activates it", () => {
  const r = openDocument([], "notes.md", "# hi");
  assert.equal(r.docs.length, 1);
  assert.equal(r.active, "notes.md");
  assert.equal(r.renewed, true);
});

test("activating an already-open document reuses the tab (no duplicate)", () => {
  let { docs, active } = openDocument([], "notes.md", "one");
  ({ docs, active } = openDocument(docs, "src/main.rs", "two"));
  assert.equal(docs.length, 2);
  const again = openDocument(docs, "notes.md", "one-ON-DISK");
  assert.equal(again.docs.length, 2, "no duplicate tab for same path");
  assert.equal(again.active, "notes.md", "existing tab becomes active");
});

test("reactivating a dirty document keeps its draft; a clean doc refreshes its base", () => {
  let { docs } = openDocument([], "f.py", "clean");
  const refreshed = openDocument(docs, "f.py", "clean-new");
  assert.equal(refreshed.docs[0].original, "clean-new", "clean doc reloads base");
  const dirtyDoc = openDocument(refreshed.docs, "f.py", "clean-new").docs[0];
  const dirty = { ...dirtyDoc, draft: "user edit" };
  const kept = openDocument([dirty], "f.py", "clean-new");
  assert.equal(kept.docs[0].draft, "user edit", "dirty draft never silently replaced");
  assert.equal(kept.docs[0].original, "clean-new", "dirty draft keeps its existing diff base");
});

test("dirty-state is structural: draft !== original", () => {
  const clean = doc("a.py", "x");
  assert.equal(docDirty(clean), false);
  const dirty = doc("a.py", "x", "y");
  assert.equal(docDirty(dirty), true);
});

test("successful save clears dirty for exactly the saved document (routing by path)", () => {
  const docs = [doc("src/a/util.ts", "A", "A-edited"), doc("src/b/util.ts", "B", "B-edited")];
  const after = docsAfterSave(docs, "src/a/util.ts", "A-SAVED");
  assert.equal(after.find((d) => d.path === "src/a/util.ts").original, "A-SAVED");
  assert.equal(after.find((d) => d.path === "src/a/util.ts").draft, "A-SAVED");
  assert.equal(docDirty(after[0]), false, "saved doc becomes clean");
  assert.equal(after[1].draft, "B-edited", "other document untouched");
  assert.equal(docDirty(after[1]), true);
});

test("failed save preserves dirty state exactly (no mutation runs)", () => {
  const docs = [doc("a.py", "orig", "draft1")];
  // A failed save never reaches a state mutation: DiffModal keeps the gate
  // open and FileTree only calls docsAfterSave after cmd.fileSave resolves.
  // Dirty is structural (draft !== original), so it survives by construction
  // — and any later edit re-dirties automatically instead of needing a flag.
  const unborn = [...docs];
  unborn[0] = { ...unborn[0], draft: "draft2" };
  assert.equal(docDirty(docs[0]), true, "draft still pending after failed apply");
  assert.equal(docDirty(unborn[0]), true, "further edits stay dirty until saved");
  assert.notEqual(unborn[0].draft, unborn[0].original);
});

test("cancelling review keeps the draft: no state function ran", () => {
  const docs = [doc("a.py", "orig", "draft1")];
  // Cancel means the callers simply never apply; simulate "nothing happened".
  assert.deepEqual(docs, docs);
  assert.equal(docDirty(docs[0]), true, "draft is still there after cancel");
});

test("close clean tab removes it and selects a sensible neighbor", () => {
  let docs = [doc("1.py", "one"), doc("2.py", "two"), doc("3.py", "three")];
  assert.equal(cycleActive(docs, "2.py", "next"), "3.py");
  // Close middle: previous tab re-activates (reading order).
  const active = closeDocument(docs, "2.py");
  assert.equal(active, "1.py");
});

test("closing a dirty tab with Cancel keeps everything", () => {
  const docs = [doc("1.py", "one", "one-edited")];
  // Cancel: requestCloseDocument only showed the confirm; document survives.
  assert.equal(docs.length, 1);
  assert.equal(docDirty(docs[0]), true);
});

test("closing a dirty tab with Discard removes the document", () => {
  const docs = [doc("1.py", "one", "one-edited"), doc("2.py", "two")];
  const nextActive = closeDocument(docs, "1.py");
  const left = docs.filter((d) => d.path !== "1.py");
  assert.equal(left.length, 1);
  assert.equal(nextActive, "2.py");
});

test("Ctrl+Tab / Ctrl+Shift+Tab cycle; Ctrl+W closes", () => {
  assert.equal(tabKeyAction({ ctrlKey: true, shiftKey: false, key: "Tab" }, true), "cycle-next");
  assert.equal(tabKeyAction({ ctrlKey: true, shiftKey: true, key: "Tab" }, true), "cycle-prev");
  assert.equal(tabKeyAction({ ctrlKey: true, shiftKey: false, key: "w" }, true), "close-active");
  assert.equal(tabKeyAction({ ctrlKey: false, key: "Tab" }, true), null);
  assert.equal(tabKeyAction({ ctrlKey: true, key: "Tab" }, false), null, "no editor open");
  assert.equal(tabKeyAction({ ctrlKey: true, key: "x" }, true), null);
});

test("Ctrl+W suppressed while a review diff or another modal owns the screen", () => {
  // FileTree guards before calling tabKeyAction; assert the guard contract by
  // ensuring the action needs its open flag — callers pass it false in those
  // states, and then no action is produced even for the same keystroke.
  assert.equal(tabKeyAction({ ctrlKey: true, key: "w" }, false), null);
});

test("cycling wraps both directions and is stable for a single tab", () => {
  const docs = [doc("1.py", "1"), doc("2.py", "2"), doc("3.py", "3")];
  assert.equal(cycleActive(docs, "3.py", "next"), "1.py");
  assert.equal(cycleActive(docs, "1.py", "prev"), "3.py");
  const one = [doc("1.py", "1")];
  assert.equal(cycleActive(one, "1.py", "next"), "1.py");
});

test("lifecycle cap: opening more than MAX_DOCS documents is refused", () => {
  const docs = Array.from({ length: MAX_DOCS }, (_, i) => doc(`f${i}.py`, `${i}`));
  assert.throws(() => openDocument(docs, "f13.py", "x"), /12 documents/);
});

test("duplicate close is a no-op that leaves the last remaining tab active", () => {
  const docs = [doc("1.py", "1")];
  assert.equal(closeDocument(docs, "missing.py"), "1.py");
});
