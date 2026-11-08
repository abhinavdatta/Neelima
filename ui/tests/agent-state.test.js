// Phase 3M live defect: TitleBar's running check omitted "cancelled", so after
// pressing Stop the Stop pill stayed and Send stayed disabled forever.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { transformSync } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../src/agentState.ts"), "utf8");
const { code } = transformSync(source, { loader: "ts", format: "cjs" });
const mod = { exports: {} };
new Function("module", "exports", code)(mod, mod.exports);
const { isAgentRunning, isTerminalAgentState } = mod.exports;

test("a cancelled task is not running", () => {
  assert.equal(isAgentRunning("cancelled"), false);
  assert.equal(isTerminalAgentState("cancelled"), true);
});

test("every terminal state ends the running indicator", () => {
  for (const state of ["idle", "done", "error", "cancelled"]) {
    assert.equal(isAgentRunning(state), false, `${state} must not look running`);
  }
});

test("in-flight states stay running", () => {
  for (const state of ["waiting_for_ai", "parsing", "awaiting_approval", "executing", "starting"]) {
    assert.equal(isAgentRunning(state), true, `${state} must look running`);
  }
});

test("a missing state is not running", () => {
  assert.equal(isAgentRunning(null), false);
  assert.equal(isAgentRunning(undefined), false);
  assert.equal(isAgentRunning(""), false);
});
