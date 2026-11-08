// Checkpoint 6 — pure agent-change integration tests.
// Covers event validation/dedupe, the targeted explorer refresh directory, the
// expansion-preserving listing merge, and open-document reconciliation.
// The mounted FileTree behavior has its own jsdom suite.
import test from "node:test";
import assert from "node:assert/strict";
import esbuild from "esbuild";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// agentChanges.ts imports editorTabs/fileTree by extensionless specifier (the
// app's Vite convention), which Node's type-stripping loader cannot resolve.
// Bundle the real modules once, then test them directly.
const here = dirname(fileURLToPath(import.meta.url));
const uiDir = join(here, "..");
const outdir = join(uiDir, "..", ".tmp", "p3p6-agent-changes");
const outfile = join(outdir, "bundle.cjs");
mkdirSync(outdir, { recursive: true });
await esbuild.build({
  stdin: {
    contents: [
      'export * from "./src/agentChanges.ts";',
      'export { applyListing, expandedDirPaths, nodesFromEntries } from "./src/fileTree.ts";',
    ].join("\n"),
    loader: "js",
    resolveDir: uiDir,
  },
  absWorkingDir: uiDir,
  tsconfig: join(uiDir, "tsconfig.json"),
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile,
  logLevel: "silent",
});
const {
  appendAgentChange, changeSummary, mergeListing, parseFileChanged,
  reconcileDocAfterExternalWrite, reconcileDocsAfterExternalWrite, refreshDirFor,
  applyListing, expandedDirPaths, nodesFromEntries,
} = createRequire(import.meta.url)(outfile);

const change = (overrides = {}) => ({
  key: "t1:c1:a.txt",
  taskId: "t1",
  callId: "c1",
  actionId: "a1",
  tool: "edit_file",
  path: "a.txt",
  workspace: "C:/ws",
  at: 1,
  ...overrides,
});

test("file-changed events are accepted only when verified and complete", () => {
  const ok = parseFileChanged({
    kind: "file-changed", verified: true, task_id: "t1", call_id: "c1",
    action_id: "a1", tool: "edit_file", path: "src/a.txt", workspace: "C:/ws",
  }, 123);
  assert.equal(ok.key, "t1:c1:src/a.txt");
  assert.equal(ok.path, "src/a.txt");
  assert.equal(ok.at, 123);
  assert.equal(ok.actionId, "a1");

  for (const bad of [
    null,
    { kind: "file-changed", verified: false, task_id: "t", path: "a", workspace: "w" },
    { kind: "file-changed", verified: true, task_id: "", path: "a", workspace: "w" },
    { kind: "file-changed", verified: true, task_id: "t", path: "", workspace: "w" },
    { kind: "file-changed", verified: true, task_id: "t", path: "a", workspace: "" },
    { kind: "transcript", verified: true, task_id: "t", path: "a", workspace: "w" },
  ]) {
    assert.equal(parseFileChanged(bad), null, JSON.stringify(bad));
  }
});

test("changes dedupe by task/call/path and stay bounded", () => {
  const first = change();
  let list = appendAgentChange([], first);
  assert.equal(list.length, 1);
  assert.equal(appendAgentChange(list, first), list, "an exact replay is a no-op");

  // Same path, different call occurrence (a real second write) is kept.
  list = appendAgentChange(list, change({ key: "t1:c2:a.txt", callId: "c2" }));
  assert.equal(list.length, 2);

  for (let i = 0; i < 120; i += 1) {
    list = appendAgentChange(list, change({ key: `k${i}`, path: `f${i}.txt` }));
  }
  assert.equal(list.length, 100, "history is bounded");
  assert.equal(list.at(-1).path, "f119.txt");
});

test("refresh targets the deepest expanded directory, never the whole tree", () => {
  assert.equal(refreshDirFor("a.txt", [""]), "", "root file refreshes the root");
  assert.equal(
    refreshDirFor("src/deep/a.txt", ["", "src", "src/deep", "other"]),
    "src/deep",
  );
  assert.equal(
    refreshDirFor("src/new/a.txt", ["", "src"]),
    "src",
    "an unloaded parent refreshes its deepest loaded ancestor",
  );
  assert.equal(
    refreshDirFor("src2/a.txt", ["", "src"]),
    "",
    "a prefix without a separator is not an ancestor",
  );
  assert.equal(
    refreshDirFor("src/deep/a.txt", ["", "src"]),
    "src",
    "prefers the deepest ancestor that is actually expanded",
  );
});

test("mergeListing preserves expansion below the refreshed directory", () => {
  let tree = nodesFromEntries([
    { name: "src", dir: true, path: "src" },
    { name: "readme.md", dir: false, path: "readme.md" },
  ]);
  tree = applyListing(tree, {
    path: "src",
    entries: [
      { name: "ui", dir: true, path: "src/ui" },
      { name: "old.txt", dir: false, path: "src/old.txt" },
    ],
  });
  tree = applyListing(tree, {
    path: "src/ui",
    entries: [{ name: "x.ts", dir: false, path: "src/ui/x.ts" }],
  });
  assert.equal(tree[0].children[0].open, true);

  const merged = mergeListing(tree, {
    path: "src",
    entries: [
      { name: "ui", dir: true, path: "src/ui" },
      { name: "new.txt", dir: false, path: "src/new.txt" },
    ],
    unreadable: 1,
  });
  assert.equal(merged[0].open, true, "the refreshed directory stays open");
  const ui = merged[0].children.find((node) => node.path === "src/ui");
  assert.equal(ui.open, true, "a loaded descendant keeps its expansion");
  assert.deepEqual(ui.children.map((node) => node.path), ["src/ui/x.ts"]);
  assert.equal(
    merged[0].children.some((node) => node.path === "src/old.txt"),
    false,
    "vanished entries are dropped",
  );
  assert.equal(
    merged[0].children.some((node) => node.path === "src/new.txt"),
    true,
    "new entries appear",
  );
  assert.equal(merged[0].unreadable, 1);
  assert.equal(merged[0].truncated, false);
});

test("a root merge keeps top-level directories expanded", () => {
  let tree = nodesFromEntries([{ name: "src", dir: true, path: "src" }]);
  tree = applyListing(tree, {
    path: "src",
    entries: [{ name: "a.ts", dir: false, path: "src/a.ts" }],
  });
  const merged = mergeListing(tree, {
    path: "",
    entries: [
      { name: "src", dir: true, path: "src" },
      { name: "pkg.json", dir: false, path: "pkg.json" },
    ],
  });
  assert.equal(merged[0].open, true);
  assert.deepEqual(merged[0].children.map((node) => node.path), ["src/a.ts"]);
  assert.equal(merged[1].path, "pkg.json");
});

test("open documents reload only when clean; a dirty draft is never replaced", () => {
  const clean = { path: "a.txt", original: "old", draft: "old" };
  const reloaded = reconcileDocAfterExternalWrite(clean, "new");
  assert.equal(reloaded.reloaded, true);
  assert.equal(reloaded.conflict, false);
  assert.deepEqual(reloaded.doc, { path: "a.txt", original: "new", draft: "new" });

  const same = reconcileDocAfterExternalWrite(reloaded.doc, "new");
  assert.equal(same.reloaded, false);
  assert.equal(same.conflict, false);
  assert.equal(same.doc, reloaded.doc);

  const dirty = { path: "a.txt", original: "old", draft: "my work" };
  const kept = reconcileDocAfterExternalWrite(dirty, "agent work");
  assert.equal(kept.reloaded, false);
  assert.equal(kept.conflict, true);
  assert.equal(kept.doc, dirty, "the unsaved draft is byte-for-byte preserved");
  assert.equal(kept.doc.draft, "my work");
  assert.equal(kept.doc.original, "old", "the review baseline is not silently moved");
});

test("reconciliation touches only the matching tab and keeps other drafts", () => {
  const docs = [
    { path: "a.txt", original: "a", draft: "a" },
    { path: "src/a.txt", original: "same-basename", draft: "same-basename" },
    { path: "b.txt", original: "b", draft: "unsaved work" },
  ];
  const result = reconcileDocsAfterExternalWrite(docs, "a.txt", "agent text");
  assert.equal(result.reloaded, true);
  assert.deepEqual(result.docs.map((doc) => doc.path), ["a.txt", "src/a.txt", "b.txt"]);
  assert.equal(result.docs[0].draft, "agent text");
  assert.equal(result.docs[0].original, "agent text");
  assert.equal(result.docs[1], docs[1], "another file with the same basename is untouched");
  assert.equal(result.docs[2].draft, "unsaved work", "an unrelated dirty tab keeps its draft");

  const missing = reconcileDocsAfterExternalWrite(docs, "missing.txt", "x");
  assert.equal(missing.reloaded, false);
  assert.equal(missing.conflict, false);
  assert.equal(missing.docs, docs);

  const dirty = [{ path: "a.txt", original: "a", draft: "mine" }];
  const kept = reconcileDocsAfterExternalWrite(dirty, "a.txt", "agent");
  assert.equal(kept.reloaded, false);
  assert.equal(kept.conflict, true);
  assert.equal(kept.docs[0].draft, "mine");
  assert.equal(kept.docs[0].original, "a");
});

test("change summary names the tool and full provenance", () => {
  assert.match(changeSummary(change()), /edit_file/);
  assert.match(changeSummary(change()), /c1/);
  assert.match(changeSummary(change()), /a1/);
  assert.doesNotMatch(changeSummary(change({ tool: "", callId: "", actionId: null })), /· call/);
});

test("expandedDirPaths still provides the candidate set used by refresh", () => {
  let tree = nodesFromEntries([{ name: "src", dir: true, path: "src" }]);
  tree = applyListing(tree, {
    path: "src",
    entries: [{ name: "sub", dir: true, path: "src/sub" }],
  });
  tree = applyListing(tree, {
    path: "src/sub",
    entries: [{ name: "x.ts", dir: false, path: "src/sub/x.ts" }],
  });
  assert.deepEqual(expandedDirPaths(tree), ["", "src", "src/sub"]);
  assert.equal(refreshDirFor("src/sub/x.ts", expandedDirPaths(tree)), "src/sub");
});
