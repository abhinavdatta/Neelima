// Phase 3Q-2b — the file context menu: only supported actions, path joining
// per platform, and roving focus. Pure module.
import test from "node:test";
import assert from "node:assert/strict";
import { fileMenuItems, absoluteWorkspacePath, menuIndexForKey } from "../src/fileMenu.ts";

test("the menu offers only actions the backend actually supports", () => {
  const ids = fileMenuItems().map((item) => item.id);
  assert.deepEqual(ids, ["open", "preview", "copy-relative", "copy-absolute", "share"]);
  const labels = fileMenuItems().map((item) => item.label);
  assert.deepEqual(labels, [
    "Open in editor", "Preview", "Copy relative path", "Copy absolute path", "Share with chat",
  ]);
});

test("rename, delete, create and reveal are not promised", () => {
  const text = fileMenuItems().map((item) => item.label.toLowerCase()).join(" ");
  for (const absent of ["rename", "delete", "new file", "new folder", "reveal", "move"]) {
    assert.ok(!text.includes(absent), `${absent} has no backend command, so it must not appear`);
  }
});

test("absolute paths follow the workspace's own separator", () => {
  assert.equal(absoluteWorkspacePath("C:\\work\\proj", "src/app.ts"), "C:\\work\\proj\\src\\app.ts");
  assert.equal(absoluteWorkspacePath("/home/me/proj", "src/app.ts"), "/home/me/proj/src/app.ts");
  assert.equal(absoluteWorkspacePath("C:/mixed/root", "a/b.txt"), "C:/mixed/root/a/b.txt");
});

test("trailing and leading separators never double up", () => {
  assert.equal(absoluteWorkspacePath("C:\\work\\proj\\", "/src/app.ts"), "C:\\work\\proj\\src\\app.ts");
  assert.equal(absoluteWorkspacePath("/home/me/proj/", "src/app.ts"), "/home/me/proj/src/app.ts");
  assert.equal(absoluteWorkspacePath("/home/me/proj", "a//b///c.txt"), "/home/me/proj/a/b/c.txt");
});

test("a missing root copies the relative path rather than inventing one", () => {
  assert.equal(absoluteWorkspacePath("", "src/app.ts"), "src/app.ts");
  assert.equal(absoluteWorkspacePath(null, "src/app.ts"), "src/app.ts");
  assert.equal(absoluteWorkspacePath("C:\\ws", ""), "C:\\ws\\");
});

test("roving focus wraps and supports Home/End", () => {
  assert.equal(menuIndexForKey(0, 5, "ArrowDown"), 1);
  assert.equal(menuIndexForKey(4, 5, "ArrowDown"), 0);
  assert.equal(menuIndexForKey(0, 5, "ArrowUp"), 4);
  assert.equal(menuIndexForKey(3, 5, "Home"), 0);
  assert.equal(menuIndexForKey(0, 5, "End"), 4);
  assert.equal(menuIndexForKey(0, 5, "Tab"), null);
  assert.equal(menuIndexForKey(0, 5, "Escape"), null);
  assert.equal(menuIndexForKey(0, 0, "ArrowDown"), null, "an empty menu has no focus target");
});
