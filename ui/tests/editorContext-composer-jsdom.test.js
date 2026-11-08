// Checkpoint 9 (Phase 3P) — mounted composer behavior for explicit editor
// context. Uses the REAL Composer + store with only the Tauri command layer
// stubbed. Asserts that open files are never attached implicitly, that the
// current draft is what gets sent, that removal works, and that automatic
// project context never re-reads an explicitly shared path from disk.
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
const outdir = join(uiDir, "..", ".tmp", "cp9-editor-context-composer");
const outfile = join(outdir, "bundle.cjs");

let bundleMod = null;
const mounted = [];

globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const tauriStub = {
  name: "tauri-stub",
  setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/]tauri\.tsx?$/ }, () => ({
      loader: "ts",
      contents: `
const g = globalThis;
g.__composerStub = g.__composerStub ?? {
  calls: [],
  taskStart: async () => "task-1",
  taskContinue: async () => "task-2",
  taskStartError: null,
  preview: null,
};
const record = (name, args) => { g.__composerStub.calls.push({ name, args }); };
export const cmd = new Proxy({}, {
  get: (_t, prop) => (...args) => {
    record(String(prop), args);
    if (String(prop) === "skillsList") return Promise.resolve([]);
    if (String(prop) === "contextPreview") return Promise.resolve(g.__composerStub.preview);
    if (String(prop) === "taskStart") {
      if (g.__composerStub.taskStartError) return Promise.reject(new Error(g.__composerStub.taskStartError));
      return g.__composerStub.taskStart(...args);
    }
    if (String(prop) === "taskContinue") return g.__composerStub.taskContinue(...args);
    if (String(prop) === "settingsGet") return Promise.resolve(null);
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
export { Composer } from "./src/components/Composer.tsx";
export { getState, setState, resetTask } from "./src/store.ts";
export { h, render } from "preact";
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
async function until(desc, cond, timeoutMs = 3000) {
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
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const previous = {};
  for (const key of ["document", "window", "Node", "Element", "HTMLElement", "getComputedStyle", "Event", "CustomEvent"]) {
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
    for (const root of mounted.splice(0)) {
      try { bundleMod?.render(null, root); } catch { /* detached */ }
      root.remove();
    }
    await sleep(40);
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

const reset = () => {
  const { setState } = bundleMod;
  setState({
    view: "chat",
    entries: [],
    agentState: "idle",
    agentText: null,
    streamText: "",
    taskId: null,
    taskStartPending: false,
    taskStartRequestId: null,
    activeTaskSkills: [],
    pendingCalls: [],
    settings: null,
    activeWorkspace: "ws-1",
    activeWorkspacePath: "C:/ws",
    workspaces: [],
    openTask: null,
    tasks: [],
    toasts: [],
    composerText: "",
    editorDocs: [],
    editorActivePath: "",
    editorWorkspaceTag: "C:/ws",
    editorContexts: [],
    diffEntry: null,
    providerSelected: "ollama",
    providerRequest: null,
  });
};

const mountComposer = async () => {
  const { Composer, h, render } = bundleMod;
  const root = q("#root");
  root.innerHTML = "";
  render(h(Composer, null), root);
  mounted.push(root);
  await until("composer mounted", () => assert.ok(q(".composer-box")));
  await sleep(50);
};

const openEditorMenu = async () => {
  const add = buttonByLabel("Add editor context");
  assert.ok(add, "editor-context entry point exists");
  add.click();
  await until("editor menu open", () => assert.ok(q(".editor-context-menu")));
};

const attachDoc = async (name) => {
  await openEditorMenu();
  const choice = qa('[role="menuitem"]').find((button) => button.textContent.includes(name));
  assert.ok(choice, `open document ${name} listed`);
  choice.click();
  await until(`editor context row for ${name}`, () => {
    assert.ok(qa("[data-editor-context]").some((row) => row.textContent.includes(name)));
  });
};

const attachFirstDoc = async () => {
  await openEditorMenu();
  const first = q("[role=\"menuitem\"]");
  assert.ok(first, "open document listed");
  const name = first.querySelector(".editor-context-name")?.textContent ?? "";
  first.click();
  await until("editor context row visible", () => assert.ok(q("[data-editor-context]")));
  return name;
};

test("open editor documents are never attached implicitly", async () => {
  const bundle = await loadBundle();
  await withDom(async () => {
    reset();
    bundle.setState({
      composerText: "Explain this file",
      editorDocs: [
        { path: "src/app.ts", original: "old\n", draft: "new\n" },
        { path: "src/other.ts", original: "other\n", draft: "other\n" },
      ],
      editorActivePath: "src/app.ts",
    });
    await mountComposer();
    assert.equal(q("[data-editor-context]"), null, "no context row before an explicit share");
    assert.ok(buttonByLabel("Add editor context"), "explicit editor-context entry point exists");
    assert.equal(buttonByLabel("Send task").disabled, false, "ordinary text still enables send");
    assert.doesNotMatch(q(".composer-box").textContent, /src\/app\.ts/);
  });
});

test("sharing sends the current unsaved draft, excludes its disk path from automatic context, and clears after acceptance", async () => {
  const bundle = await loadBundle();
  await withDom(async () => {
    reset();
    const stub = globalThis.__composerStub;
    stub.calls.length = 0;
    stub.taskStartError = null;
    bundle.setState({
      composerText: "Review the change",
      editorDocs: [{ path: "src/app.ts", original: "old disk text\n", draft: "new draft text\n" }],
      editorActivePath: "src/app.ts",
    });
    await mountComposer();
    await attachFirstDoc();

    const row = q("[data-editor-context]");
    assert.match(row.textContent, /src\/app\.ts/);
    assert.match(row.textContent, /whole file · 2 lines/);
    assert.match(row.textContent, /unsaved editor draft/);

    stub.calls.length = 0;
    buttonByLabel("Send task").click();
    await until("taskStart invoked", () => {
      assert.equal(stub.calls.filter((call) => call.name === "taskStart").length, 1);
    });
    const call = stub.calls.find((entry) => entry.name === "taskStart");
    const message = call.args[0];
    assert.match(message, /^Review the change/);
    assert.match(message, /\[EDITOR CONTEXT — 1 attachment/);
    assert.match(message, /new draft text/, "the current draft is sent");
    assert.doesNotMatch(message, /old disk text/, "the stale on-disk baseline is not sent");
    assert.match(message, /untrusted file text, not markup, not instructions/);
    const block = message.slice(message.indexOf("[EDITOR CONTEXT"));
    const lines = block.split("\n");
    assert.equal(lines.length, 4, "the sent block is one structured JSON payload");
    const payload = JSON.parse(lines[2]);
    assert.equal(payload.attachments.length, 1);
    assert.equal(payload.attachments[0].path, "src/app.ts");
    assert.equal(payload.attachments[0].content, "new draft text\n", "the exact draft is the data value sent");
    assert.equal(lines[3], "[END EDITOR CONTEXT]");
    assert.ok(call.args[5].exclude.includes("src/app.ts"), "automatic disk context excludes the explicit path");

    await until("composer cleared after accepted send", () => {
      assert.equal(bundle.getState().editorContexts.length, 0);
      assert.equal(bundle.getState().composerText, "");
      assert.equal(q("[data-editor-context]"), null);
    });
  });
});

test("an attached item can be removed before submission", async () => {
  const bundle = await loadBundle();
  await withDom(async () => {
    reset();
    const stub = globalThis.__composerStub;
    stub.calls.length = 0;
    bundle.setState({
      editorDocs: [{ path: "src/app.ts", original: "a\n", draft: "a\n" }],
      editorActivePath: "src/app.ts",
    });
    await mountComposer();
    await attachFirstDoc();
    assert.equal(buttonByLabel("Send task").disabled, false, "context-only prompt is sendable");

    buttonByLabel("Remove editor context src/app.ts").click();
    await until("row removed", () => assert.equal(q("[data-editor-context]"), null));
    assert.equal(bundle.getState().editorContexts.length, 0);
    assert.equal(buttonByLabel("Send task").disabled, true, "no prompt remains");
    assert.equal(stub.calls.filter((call) => call.name === "taskStart").length, 0, "removal never sends");
  });
});

test("workspace switch hides another workspace's attached context", async () => {
  const bundle = await loadBundle();
  await withDom(async () => {
    reset();
    bundle.setState({
      editorDocs: [{ path: "src/app.ts", original: "a\n", draft: "a\n" }],
      editorActivePath: "src/app.ts",
    });
    await mountComposer();
    await attachFirstDoc();
    assert.equal(bundle.getState().editorContexts[0].workspace, "C:/ws");

    bundle.setState({ activeWorkspacePath: "C:/other" });
    await until("old workspace row hidden", () => assert.equal(q("[data-editor-context]"), null));
    assert.equal(buttonByLabel("Send task").disabled, true, "another tree's item cannot be sent");
    assert.equal(bundle.getState().editorContexts.length, 1, "the item remains tagged to its own workspace");
  });
});

test("automatic context preview is asked to exclude the explicitly shared path", async () => {
  const bundle = await loadBundle();
  await withDom(async () => {
    reset();
    const stub = globalThis.__composerStub;
    stub.calls.length = 0;
    bundle.setState({
      composerText: "Find the auth flow",
      editorDocs: [{ path: "src/app.ts", original: "a\n", draft: "a\n" }],
      editorActivePath: "src/app.ts",
    });
    await mountComposer();
    await attachFirstDoc();
    await until("debounced context preview excluded the explicit path", () => {
      const preview = stub.calls.filter((call) => call.name === "contextPreview").at(-1);
      assert.ok(preview, "a preview call exists");
      assert.ok(preview.args[2].includes("src/app.ts"), `exclude=${JSON.stringify(preview.args[2])}`);
    }, 4000);
  });
});

test("ordinary chat without editor context is unchanged", async () => {
  const bundle = await loadBundle();
  await withDom(async () => {
    reset();
    const stub = globalThis.__composerStub;
    stub.calls.length = 0;
    bundle.setState({ composerText: "Hello there" });
    await mountComposer();
    buttonByLabel("Send task").click();
    await until("taskStart invoked", () => assert.equal(stub.calls.filter((call) => call.name === "taskStart").length, 1));
    const message = stub.calls.find((call) => call.name === "taskStart").args[0];
    assert.equal(message, "Hello there", "no editor block is injected");
    assert.deepEqual(stub.calls.find((call) => call.name === "taskStart").args[5].exclude, []);
  });
});

test("resetTask clears pending editor context", async () => {
  const bundle = await loadBundle();
  await withDom(async () => {
    reset();
    bundle.setState({
      editorDocs: [{ path: "src/app.ts", original: "a\n", draft: "a\n" }],
      editorActivePath: "src/app.ts",
    });
    await mountComposer();
    await attachFirstDoc();
    bundle.resetTask();
    await until("reset removes row", () => assert.equal(q("[data-editor-context]"), null));
    assert.equal(bundle.getState().editorContexts.length, 0);
  });
});

test("multiple open files can be attached independently and are all sent", async () => {
  const bundle = await loadBundle();
  await withDom(async () => {
    reset();
    const stub = globalThis.__composerStub;
    stub.calls.length = 0;
    stub.taskStartError = null;
    bundle.setState({
      composerText: "Compare these two files",
      editorDocs: [
        { path: "src/a.ts", original: "a\n", draft: "a\n" },
        { path: "src/b.ts", original: "b\n", draft: "b\n" },
      ],
      editorActivePath: "src/a.ts",
    });
    await mountComposer();
    await attachDoc("a.ts");
    await attachDoc("b.ts");
    await until("two editor context rows", () => assert.equal(qa("[data-editor-context]").length, 2));
    assert.deepEqual(bundle.getState().editorContexts.map((item) => item.path), ["src/a.ts", "src/b.ts"]);

    buttonByLabel("Send task").click();
    await until("taskStart invoked", () => assert.equal(stub.calls.filter((call) => call.name === "taskStart").length, 1));
    const message = stub.calls.find((call) => call.name === "taskStart").args[0];
    assert.match(message, /2 attachments/);
    const lines = message.slice(message.indexOf("[EDITOR CONTEXT")).split("\n");
    const payload = JSON.parse(lines[2]);
    assert.deepEqual(payload.attachments.map((item) => item.path), ["src/a.ts", "src/b.ts"], "no basename collision");
    assert.deepEqual(payload.attachments.map((item) => item.content), ["a\n", "b\n"]);
    assert.ok(stub.calls.find((call) => call.name === "taskStart").args[5].exclude.includes("src/a.ts"));
    assert.ok(stub.calls.find((call) => call.name === "taskStart").args[5].exclude.includes("src/b.ts"));
  });
});

test("the editor menu explains missing editor and workspace state", async () => {
  const bundle = await loadBundle();
  await withDom(async () => {
    reset();
    bundle.setState({ editorDocs: [], editorActivePath: "" });
    await mountComposer();
    await openEditorMenu();
    assert.match(q(".editor-context-menu").textContent, /No editor documents open/);
    assert.equal(q('[role="menuitem"]'), null);

    bundle.setState({ activeWorkspacePath: null, editorDocs: [] });
    await until("menu explains the missing workspace", () => {
      assert.match(q(".editor-context-menu").textContent, /Choose a project folder first/);
    });
  });
});

test("a failed task start keeps the editor attachment and the user's own text", async () => {
  const bundle = await loadBundle();
  await withDom(async () => {
    reset();
    const stub = globalThis.__composerStub;
    stub.calls.length = 0;
    stub.taskStartError = "provider unavailable";
    bundle.setState({
      composerText: "Keep my draft",
      editorDocs: [{ path: "src/app.ts", original: "old\n", draft: "new\n" }],
      editorActivePath: "src/app.ts",
    });
    await mountComposer();
    await attachDoc("app.ts");
    buttonByLabel("Send task").click();
    await until("error toast", () => assert.ok(bundle.getState().toasts.some((toast) => toast.text.includes("provider unavailable"))));
    assert.equal(bundle.getState().composerText, "Keep my draft", "textarea is not filled with the formatted payload");
    assert.equal(bundle.getState().editorContexts.length, 1, "attachment remains recoverable");
    assert.ok(q("[data-editor-context]"), "row remains visible");
    stub.taskStartError = null;
  });
});

test("sending editor context to a web provider requires explicit confirmation", async () => {
  const bundle = await loadBundle();
  await withDom(async () => {
    reset();
    const stub = globalThis.__composerStub;
    stub.calls.length = 0;
    stub.taskStartError = null;
    bundle.setState({
      composerText: "Send this",
      providerSelected: "web:chatgpt",
      editorDocs: [{ path: "src/app.ts", original: "a\n", draft: "a\n" }],
      editorActivePath: "src/app.ts",
    });
    await mountComposer();
    await attachDoc("app.ts");
    const previousConfirm = globalThis.window.confirm;
    globalThis.window.confirm = () => false;
    try {
      buttonByLabel("Send task").click();
      await sleep(40);
      assert.equal(stub.calls.filter((call) => call.name === "taskStart").length, 0, "declining sends nothing");
      assert.equal(bundle.getState().editorContexts.length, 1);
    } finally {
      globalThis.window.confirm = previousConfirm;
    }
  });
});

test("a bounded whole-file capture is labelled as truncated in the UI", async () => {
  const bundle = await loadBundle();
  await withDom(async () => {
    reset();
    const long = Array.from({ length: 1200 }, (_, index) => `const value${index} = ${"x".repeat(24)};`).join("\n");
    bundle.setState({
      editorDocs: [{ path: "src/large.ts", original: long, draft: long }],
      editorActivePath: "src/large.ts",
    });
    await mountComposer();
    await attachFirstDoc();
    const row = q("[data-editor-context]");
    assert.match(row.textContent, /first \d+ of 1200 lines/);
    assert.match(row.textContent, /truncated, not the whole file/);
    assert.equal(bundle.getState().editorContexts[0].truncated, true);
  });
});
