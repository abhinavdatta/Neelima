// CP10 integration defect: switching projects left the previous workspace's
// finished task transcript on screen under the new workspace name, even though
// the backend refuses to continue a task from another tree. The switch rule is
// pure, so it is tested here instead of inferred from the GUI.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { transformSync } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../src/workspaceSwitch.ts"), "utf8");
const { code } = transformSync(source, { loader: "ts", format: "cjs" });
const mod = { exports: {} };
new Function("module", "exports", code)(mod, mod.exports);
const { workspaceSwitchClearsTask, clearedTaskView } = mod.exports;

test("startup resolution of the first workspace is not a switch", () => {
  assert.equal(workspaceSwitchClearsTask(null, "/work/a"), false);
  assert.equal(workspaceSwitchClearsTask(null, null), false);
});

test("re-selecting the same workspace keeps the task view", () => {
  assert.equal(workspaceSwitchClearsTask("/work/a", "/work/a"), false);
});

test("a different workspace invalidates the displayed task", () => {
  assert.equal(workspaceSwitchClearsTask("/work/a", "/work/b"), true);
  assert.equal(workspaceSwitchClearsTask("/work/a", null), true);
});

test("the cleared patch drops the task association but not the draft", () => {
  const patch = clearedTaskView();
  assert.deepEqual(patch.entries, []);
  assert.equal(patch.taskId, null);
  assert.equal(patch.openTask, null);
  assert.equal(patch.agentState, "idle");
  assert.deepEqual(patch.pendingCalls, []);
  assert.equal("composerText" in patch, false, "unsent composer text survives a project switch");
  assert.equal("editorContexts" in patch, false, "editor context is cleared by the caller");
});
