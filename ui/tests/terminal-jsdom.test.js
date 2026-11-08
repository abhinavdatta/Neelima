// Checkpoint 7 — mounted terminal drawer tests with the real TerminalPanel,
// real store and preact, but stubbed xterm/FitAddon and Tauri commands. These
// prove the frontend lifecycle: pre-session event replay, workspace switching,
// error/retry, exit status, and disposal. The Rust PTY itself is covered by
// terminal::tests in src-tauri/src/terminal.rs.
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
const outdir = join(repoDir, ".tmp", "cp7-terminal-panel");
const outfile = join(outdir, "bundle.cjs");

let bundleMod = null;
const mountedRoots = [];

const xtermStub = {
  name: "xterm-stub",
  setup(build) {
    build.onLoad({ filter: /[\\/]@xterm[\\/]xterm$|[\\/]@xterm[\\/]xterm[\\/]lib[\\/]xterm\.js$/ }, () => ({
      loader: "js",
      contents: `
const g = globalThis;
g.__xtermStub = g.__xtermStub ?? { terminals: [] };
class FakeTerminal {
  constructor(options) {
    this.options = options;
    this.rows = 24;
    this.cols = 80;
    this.writes = [];
    this.disposed = false;
    this.focused = false;
    this.input = null;
    g.__xtermStub.terminals.push(this);
  }
  loadAddon() {}
  open() {}
  write(data) { this.writes.push(data); }
  writeln(data) { this.writes.push(data); }
  onData(cb) { this.input = cb; return { dispose: () => { this.input = null; } }; }
  focus() { this.focused = true; }
  dispose() { this.disposed = true; }
}
export class Terminal extends FakeTerminal {}
`,
    }));
    build.onLoad({ filter: /@xterm[\\/]addon-fit/ }, () => ({
      loader: "js",
      contents: `export class FitAddon { fit() {} }`,
    }));
  },
};

const tauriStub = {
  name: "tauri-stub",
  setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/]tauri\.tsx?$/ }, () => ({
      loader: "ts",
      contents: `
const g = globalThis;
g.__termStub = g.__termStub ?? { calls: [], termCreate: async () => 1, termWrite: async () => {}, termResize: async () => {}, termKill: async () => {} };
export const cmd = new Proxy({}, {
  get: (_t, prop) => (...args) => {
    const name = String(prop);
    g.__termStub.calls.push({ name, args });
    const fn = g.__termStub[name];
    return fn ? fn(...args) : Promise.resolve(null);
  },
});
export const listen = () => Promise.resolve(() => {});
`,
    }));
  },
};

const entry = `
import { options } from "preact";
options.debounceRendering = (fn) => fn();
export { TerminalPanel } from "./src/components/TerminalPanel.tsx";
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
    plugins: [xtermStub, tauriStub],
    define: { "process.env.NODE_ENV": '"test"' },
    logLevel: "silent",
  });
  const req = createRequire(import.meta.url);
  bundleMod = req(outfile);
  return bundleMod;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(desc, cond, timeoutMs = 2500) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      await cond();
      return;
    } catch (error) {
      last = error;
    }
    await sleep(20);
  }
  throw new Error(`condition not met within ${timeoutMs}ms: ${desc}${last ? ` — ${String(last)}` : ""}`);
}

const q = (selector) => globalThis.document.querySelector(selector);
const qa = (selector) => [...globalThis.document.querySelectorAll(selector)];
const text = () => globalThis.document.body.textContent ?? "";
const button = (label) => qa("button").find((el) => el.textContent.trim() === label);

const withDom = async (run) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const previous = {};
  for (const key of ["document", "window", "CustomEvent", "Event", "Node", "Element", "HTMLElement", "getComputedStyle", "ResizeObserver", "requestAnimationFrame", "cancelAnimationFrame"]) {
    try {
      previous[key] = globalThis[key];
      globalThis[key] = dom.window[key];
    } catch {
      previous[key] = undefined;
    }
  }
  globalThis.window = dom.window;
  try {
    await run(dom);
  } finally {
    // Unmount tracked roots while this window's globals still exist. Clearing
    // the body alone would leave the component subscribed to the store; the
    // next test would then react to its workspace update with a second PTY.
    unmountAll();
    await sleep(60);
    unmountAll();
    dom.window.document.body.innerHTML = "";
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete globalThis[key];
      else globalThis[key] = previous[key];
    }
  }
};

function unmountAll() {
  for (const root of mountedRoots.splice(0)) {
    try {
      bundleMod?.render(null, root);
    } catch { /* already detached */ }
    root.remove();
  }
}

function resetStub() {
  globalThis.__xtermStub = globalThis.__xtermStub ?? { terminals: [] };
  globalThis.__termStub = globalThis.__termStub ?? { calls: [] };
  const stub = globalThis.__termStub;
  stub.calls.length = 0;
  stub.termCreate = async () => 1;
  stub.termWrite = async () => {};
  stub.termResize = async () => {};
  stub.termKill = async () => {};
  globalThis.__xtermStub.terminals.length = 0;
}

function mount(bundle, workspace) {
  bundle.setState({
    activeWorkspacePath: workspace,
    activeWorkspace: workspace ? "ws" : null,
    terminalOpen: true,
    diffEntry: null,
    toasts: [],
  });
  const root = globalThis.document.createElement("div");
  globalThis.document.body.appendChild(root);
  mountedRoots.push(root);
  bundle.render(bundle.h(bundle.TerminalPanel, null), root);
  return root;
}

const calls = (name) => globalThis.__termStub.calls.filter((call) => call.name === name);

test("terminal does not spawn without a workspace", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    resetStub();
    mount(bundle, null);
    await until("no-workspace copy", () => assert.match(text(), /Open a project folder to use the terminal/));
    assert.equal(calls("termCreate").length, 0, "no PTY is created");
    assert.match(text(), /No workspace/);
  });
});

test("output emitted before termCreate resolves is buffered and replayed", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    resetStub();
    let release;
    globalThis.__termStub.termCreate = () => new Promise((resolve) => { release = resolve; });
    mount(bundle, "C:/ws");
    await until("termCreate invoked", () => assert.equal(calls("termCreate").length, 1));

    globalThis.window.dispatchEvent(new globalThis.CustomEvent("term-data", {
      detail: { kind: "term-data", session: 77, data: "EARLY_PROMPT" },
    }));
    release(77);
    await until("buffered output replayed", () => {
      const terminal = globalThis.__xtermStub.terminals[0];
      assert.ok(terminal, "terminal exists");
      assert.ok(terminal.writes.includes("EARLY_PROMPT"), `writes: ${terminal.writes}`);
    });
    assert.equal(q(".term-status")?.textContent, "Live");
    assert.equal(globalThis.__xtermStub.terminals[0].focused, true, "the shell receives keyboard focus");
  });
});

test("workspace switch disposes the old PTY and ignores its late output", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    resetStub();
    const ids = [11, 12];
    globalThis.__termStub.termCreate = async () => ids.shift();
    mount(bundle, "C:/first");
    await until("first PTY", () => assert.equal(calls("termCreate").length, 1));
    const first = globalThis.__xtermStub.terminals[0];

    bundle.setState({ activeWorkspacePath: "C:/second" });
    await until("second PTY", () => assert.equal(calls("termCreate").length, 2));
    const second = globalThis.__xtermStub.terminals[1];
    await until("old session killed", () => assert.ok(calls("termKill").some((call) => call.args[0] === 11)));
    assert.equal(first.disposed, true, "old xterm instance is disposed");

    globalThis.window.dispatchEvent(new globalThis.CustomEvent("term-data", {
      detail: { kind: "term-data", session: 11, data: "OLD_WORKSPACE" },
    }));
    globalThis.window.dispatchEvent(new globalThis.CustomEvent("term-data", {
      detail: { kind: "term-data", session: 12, data: "NEW_WORKSPACE" },
    }));
    await until("new output rendered", () => assert.ok(second.writes.includes("NEW_WORKSPACE")));
    assert.ok(!second.writes.includes("OLD_WORKSPACE"), "old session data is ignored");
  });
});

test("a real exit code is shown and Restart creates a fresh session", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    resetStub();
    let nextId = 21;
    globalThis.__termStub.termCreate = async () => nextId++;
    mount(bundle, "C:/ws");
    await until("PTY running", () => assert.equal(calls("termCreate").length, 1));
    const first = globalThis.__xtermStub.terminals[0];

    globalThis.window.dispatchEvent(new globalThis.CustomEvent("term-exit", {
      detail: { kind: "term-exit", session: 21, code: 7 },
    }));
    await until("exit status", () => assert.equal(q(".term-status")?.textContent, "Exited (7)"));
    assert.ok(first.writes.some((line) => line.includes("code 7")), "exit code is written to the terminal");
    const restart = button("Restart");
    assert.ok(restart, "Restart is offered after exit");
    restart.click();
    await until("restart creates a new PTY", () => assert.equal(calls("termCreate").length, 2));
    await until("new session is live", () => assert.equal(q(".term-status")?.textContent, "Live"));
    await until("old session killed", () => assert.ok(calls("termKill").some((call) => call.args[0] === 21)));
  });
});

test("a creation failure is reported and Retry attempts a new PTY", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    resetStub();
    globalThis.__termStub.termCreate = async () => { throw new Error("no workspace open"); };
    mount(bundle, "C:/ws");
    await until("failure status", () => {
      assert.equal(q(".term-status")?.textContent, "Failed", `error: ${q(".term-status")?.getAttribute("title")}`);
    });
    assert.equal(q(".term-status")?.getAttribute("title"), "Error: no workspace open");
    assert.match(globalThis.__xtermStub.terminals[0].writes.join(""), /Unable to start the OS terminal/);
    const retry = button("Restart");
    assert.ok(retry, "Retry is offered after failure");
    retry.click();
    await until("retry attempted another PTY", () => assert.equal(calls("termCreate").length, 2));
  });
});

test("unmounting the drawer kills the session and disposes xterm", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    resetStub();
    const root = mount(bundle, "C:/ws");
    await until("PTY running", () => assert.equal(calls("termCreate").length, 1));
    const terminal = globalThis.__xtermStub.terminals[0];
    bundle.render(null, root);
    await until("session killed", () => assert.ok(calls("termKill").some((call) => call.args[0] === 1)));
    assert.equal(terminal.disposed, true);
  });
});
