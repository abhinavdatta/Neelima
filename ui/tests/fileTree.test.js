// Checkpoint 5 — pure file-explorer tree tests.
// Covers state shaping, refresh merging without losing expansion, visible-row
// flattening, keyboard intent, retry state and honest cap/unreadable notices.
// The mounted component behavior (loading/error/empty, stale responses) has its
// own jsdom suite in fileTree-jsdom.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyListing, expandedDirPaths, listingMeta, listingNotice, nodesFromEntries,
  replaceNode, setNodeError, treeKeyAction, visibleRows,
} from "../src/fileTree.ts";

const entry = (name, dir = false, path = name) => ({ name, dir, path });
const listing = (path, entries, extra = {}) => ({ path, entries, ...extra });

test("root and nested listings shape nodes without inventing loaded directories", () => {
  const root = applyListing([], listing("", [entry("src", true, "src"), entry("a.txt")]));
  assert.deepEqual(root.map((node) => node.name), ["src", "a.txt"]);
  assert.equal(root[0].children, undefined, "a directory starts unloaded");
  assert.equal(root[0].open, undefined);
  assert.deepEqual(root[1].children, [], "a file is never expandable");

  const opened = applyListing(root, listing("src", [entry("ui", true, "src/ui")]));
  assert.equal(opened[0].open, true);
  assert.equal(opened[0].children[0].path, "src/ui");

  const nested = applyListing(opened, listing("src/ui", [entry("x.ts", false, "src/ui/x.ts")], {
    truncated: true, limit: 400, unreadable: 2,
  }));
  assert.equal(nested[0].open, true, "merging a child keeps the parent open");
  assert.equal(nested[0].children[0].open, true);
  assert.equal(nested[0].children[0].truncated, true);
  assert.equal(nested[0].children[0].limit, 400);
  assert.equal(nested[0].children[0].unreadable, 2);
});

test("applyListing leaves a vanished path alone and root listing replaces the root", () => {
  const tree = nodesFromEntries([entry("src", true, "src")]);
  const unchanged = applyListing(tree, listing("gone", [entry("x")]));
  assert.equal(unchanged[0].children, undefined);
  assert.equal(unchanged.length, 1);

  const reopened = applyListing(unchanged, listing("", [entry("other")]));
  assert.deepEqual(reopened.map((node) => node.path), ["other"]);
});

test("expandedDirPaths is root-first and parent-first for loaded open folders", () => {
  let tree = applyListing([], listing("", [entry("src", true, "src"), entry("a.txt")]));
  tree = applyListing(tree, listing("src", [entry("ui", true, "src/ui")]));
  tree = applyListing(tree, listing("src/ui", [entry("x.ts", false, "src/ui/x.ts")]));
  assert.deepEqual(expandedDirPaths(tree), ["", "src", "src/ui"]);
  assert.deepEqual(expandedDirPaths([]), [""], "refresh always reloads the root");
});

test("visibleRows exposes only rows under an open directory, with depth and parent", () => {
  let tree = applyListing([], listing("", [entry("src", true, "src"), entry("a.txt")]));
  tree = applyListing(tree, listing("src", [entry("ui", true, "src/ui"), entry("b.txt", false, "src/b.txt")]));
  const rows = visibleRows(tree);
  assert.deepEqual(rows.map((row) => row.node.path), ["src", "src/ui", "src/b.txt", "a.txt"]);
  assert.deepEqual(rows.map((row) => row.depth), [0, 1, 1, 0]);
  assert.equal(rows[1].parentPath, "src");
  assert.equal(rows[3].parentPath, null);
});

test("keyboard model: arrows move, Right expands/enters, Left collapses/parents", () => {
  const closed = nodesFromEntries([entry("src", true, "src"), entry("a.txt")]);
  let rows = visibleRows(closed);
  assert.deepEqual(treeKeyAction(rows, "src", "ArrowDown"), { kind: "focus", path: "a.txt" });
  assert.deepEqual(treeKeyAction(rows, "a.txt", "ArrowUp"), { kind: "focus", path: "src" });
  assert.deepEqual(treeKeyAction(rows, "a.txt", "Home"), { kind: "focus", path: "src" });
  assert.deepEqual(treeKeyAction(rows, "src", "End"), { kind: "focus", path: "a.txt" });
  assert.equal(treeKeyAction(rows, "src", "ArrowUp"), null);
  assert.equal(treeKeyAction(rows, "a.txt", "ArrowDown"), null);
  assert.deepEqual(treeKeyAction(rows, "src", "ArrowRight"), { kind: "expand", node: closed[0] });
  assert.deepEqual(treeKeyAction(rows, "a.txt", "Enter"), { kind: "activate", node: closed[1] });
  assert.deepEqual(treeKeyAction(rows, "src", " "), { kind: "activate", node: closed[0] });

  let open = applyListing(closed, listing("src", [entry("x.ts", false, "src/x.ts")]));
  rows = visibleRows(open);
  assert.deepEqual(treeKeyAction(rows, "src", "ArrowRight"), { kind: "focus", path: "src/x.ts" });
  assert.deepEqual(treeKeyAction(rows, "src/x.ts", "ArrowLeft"), { kind: "focus", path: "src" });
  assert.deepEqual(treeKeyAction(rows, "src", "ArrowLeft"), { kind: "collapse", node: rows[0].node });
  assert.equal(treeKeyAction([], "x", "ArrowDown"), null);
  assert.deepEqual(treeKeyAction(rows, "missing", "Home"), { kind: "focus", path: "src" });
});

test("a failed expansion keeps a retryable row and never a fake empty directory", () => {
  const tree = nodesFromEntries([entry("locked", true, "locked")]);
  const errored = setNodeError(tree, "locked", "Access is denied");
  assert.equal(errored[0].error, "Access is denied");
  assert.equal(errored[0].children, undefined, "children undefined = next click retries");
  assert.equal(errored[0].open, false);
  assert.equal(errored[0].truncated, undefined);
  assert.equal(replaceNode(tree, "missing", (node) => node)[0].path, "locked");
});

test("listing metadata is explicit and notices state caps and unreadable entries", () => {
  assert.deepEqual(listingMeta(listing("", [], { truncated: true, limit: 400, unreadable: 3 })), {
    truncated: true, limit: 400, unreadable: 3,
  });
  assert.deepEqual(listingMeta(listing("", [])), { truncated: false, limit: 0, unreadable: 0 });
  assert.equal(listingNotice({ truncated: false, limit: 0, unreadable: 0 }), null);
  assert.match(listingNotice({ truncated: true, limit: 400, unreadable: 0 }), /first 400 entries/);
  assert.match(listingNotice({ truncated: false, limit: 0, unreadable: 1 }), /1 entry could not be read/);
  assert.match(listingNotice({ truncated: false, limit: 0, unreadable: 2 }), /2 entries could not be read/);
  assert.match(
    listingNotice({ truncated: true, limit: 400, unreadable: 2 }),
    /first 400 entries.*2 entries could not be read/,
  );
});
