// Checkpoint 5 — mounted file-explorer behavior.
//
// Bundles the REAL FileTree + store with esbuild and stubs the Tauri command
// layer, then drives the states that used to be dishonest or missing:
//   • loading vs "workspace is empty" vs "no workspace open",
//   • a failed load with a working Retry,
//   • Refresh that keeps expanded folders and re-walks them,
//   • capped/unreadable listing notices,
//   • a late response from a previous workspace never entering the new tree,
//   • roving-tabindex keyboard navigation (Arrow/Home/End/Enter).
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
const outdir = join(repoDir, ".tmp", "p3p5-file-tree");
const outfile = join(outdir, "bundle.cjs");

let bundleMod = null;

const tauriStubLoader = {
  name: "tauri-stub",
  setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/]tauri\.tsx?$/ }, () => ({
      loader: "ts",
      contents: `
const g = globalThis;
g.__ftStub = g.__ftStub ?? { calls: [], tree: async () => ({ path: "", entries: [] }) };
const record = (name, args) => { g.__ftStub.calls.push({ name, args }); };
export const cmd = new Proxy({}, {
  get: (_t, prop) => (...args) => {
    record(String(prop), args);
    if (String(prop) === "tree") { return g.__ftStub.tree(...args); }
    if (String(prop) === "filePreview") {
      if (g.__ftStub.filePreview) return g.__ftStub.filePreview(...args);
      return Promise.resolve({ path: args[0], content: "", offset: 0, line_limit: 300, size_bytes: 0, has_more: false });
    }
    if (String(prop) === "settingsSet") {
      return Promise.resolve({ ...args[0] });
    }
    if (String(prop) === "fileText") {
      if (g.__ftStub.fileText) return g.__ftStub.fileText(...args);
      return Promise.resolve({ path: args[0], content: "", bytes: 0 });
    }
    return Promise.resolve(null);
  },
});
export const listen = () => Promise.resolve(() => {});
`.trim(),
    }));
  },
};

// No debounceRendering override: forcing synchronous renders makes Preact
// re-invoke an effect that sets state while effects are flushing, so the
// explorer would fetch the root twice — behavior production never exhibits.
// The assertions below poll, so normal deferred rendering is fine.
const entry = `
export { FileTree } from "./src/components/FileTree.tsx";
export { getState, setState } from "./src/store.ts";
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
    plugins: [tauriStubLoader],
    define: { "process.env.NODE_ENV": '"test"' },
    logLevel: "silent",
  });
  bundleMod = createRequire(import.meta.url)(outfile);
  return bundleMod;
}

const mountedRoots = [];

const withDom = async (run) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const previous = {};
  for (const key of ["document", "window", "MutationObserver", "KeyboardEvent", "MouseEvent",
    "Event", "HTMLElement", "Element", "Node", "requestAnimationFrame", "cancelAnimationFrame",
    "getComputedStyle"]) {
    previous[key] = globalThis[key];
    globalThis[key] = dom.window[key];
  }
  globalThis.window = dom.window;
  try {
    await run(dom);
  } finally {
    // Unmount while the DOM globals are still installed: clearing innerHTML
    // leaves Preact components mounted and subscribed to the store, so a
    // previous test's tree would keep issuing loads and could consume a
    // response the current test is waiting for.
    unmountAll();
    // Preact flushes effects through a 35 ms timer plus requestAnimationFrame;
    // let that run before the globals (and the window they belong to) go away.
    await sleep(60);
    unmountAll();
    globalThis.document.body.innerHTML = "";
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete globalThis[key];
      else globalThis[key] = previous[key];
    }
  }
};

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
const row = (path) => q(`.ft-row[data-path="${path}"]`);
const rowNames = () => qa(".ft-row").map((element) => element.getAttribute("data-path"));
const file = (path, name = path.split("/").pop()) => ({ name, dir: false, path });
const dir = (path, name = path.split("/").pop()) => ({ name, dir: true, path });

function unmountAll() {
  for (const root of mountedRoots.splice(0)) {
    try {
      if (bundleMod) bundleMod.render(null, root);
    } catch { /* already detached */ }
    root.remove();
  }
}

function mount(bundle) {
  unmountAll();
  globalThis.document.body.innerHTML = "";
  const container = globalThis.document.createElement("div");
  globalThis.document.body.appendChild(container);
  mountedRoots.push(container);
  bundle.render(bundle.h(bundle.FileTree, null), container);
}

function setWorkspace(bundle, path) {
  bundle.setState({
    view: "files",
    activeWorkspacePath: path,
    editorWorkspaceTag: null,
    editorDocs: [],
    editorActivePath: "",
    diffEntry: null,
    // Attachments are store-global (CP9): reset them so one test's share can
    // never be mistaken for the next test's result.
    editorContexts: [],
    toasts: [],
    settingsOpen: false,
    agentChanges: [],
    agentHandledKeys: [],
    agentChangeTick: 0,
  });
}

const assertNoLoadingOrError = () => {
  assert.equal(q(".ft-error"), null, "no error banner");
  assert.ok(!/Loading workspace/.test(q(".ft-empty")?.textContent ?? ""), "no stale loading state");
};

test("loading, empty and no-workspace states are distinguished", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    const stub = globalThis.__ftStub;
    stub.calls.length = 0;
    let release;
    stub.tree = () => new Promise((resolve) => { release = resolve; });
    setWorkspace(bundle, "C:/ws-a");
    mount(bundle);

    await until("loading state", () =>
      assert.match(q(".ft-empty")?.textContent ?? "", /Loading workspace/));
    assert.ok(!/empty/i.test(q(".ft-empty")?.textContent ?? ""), "loading is not called empty");

    release({ path: "", entries: [] });
    await until("empty state", () =>
      assert.equal(q(".ft-empty")?.textContent, "This workspace is empty"));
    assertNoLoadingOrError();

    setWorkspace(bundle, null);
    await until("no workspace state", () =>
      assert.equal(q(".ft-empty")?.textContent, "No workspace open"));
    assert.equal(stub.calls.filter((call) => call.name === "tree").length, 1, "no tree call without a workspace");
  });
});

test("a failed root load shows the real error and Retry recovers the tree", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    const stub = globalThis.__ftStub;
    stub.calls.length = 0;
    stub.tree = () => Promise.reject(new Error("Access is denied"));
    setWorkspace(bundle, "C:/ws-a");
    mount(bundle);

    await until("error banner", () => {
      assert.ok(q('.ft-error[role="alert"]'), "role=alert error banner present");
      assert.match(q(".ft-error")?.textContent ?? "", /Access is denied/);
    });
    assert.ok(!/empty/i.test(q(".ft-empty")?.textContent ?? ""), "a failure is not reported as an empty folder");

    stub.tree = async () => ({ path: "", entries: [dir("src"), file("a.txt")] });
    q(".ft-error button").click();
    await until("tree after retry", () => assert.deepEqual(rowNames(), ["src", "a.txt"]));
    assert.equal(q(".ft-error"), null, "the banner clears after a successful retry");
  });
});

test("refresh re-walks expanded folders and keeps them open with new content", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    const stub = globalThis.__ftStub;
    stub.calls.length = 0;
    let secondPage = false;
    stub.tree = async (path) => {
      if (!path) return { path: "", entries: [dir("src"), file("a.txt")] };
      if (path === "src") {
        return {
          path: "src",
          entries: secondPage ? [file("src/x.ts"), file("src/y.ts")] : [file("src/x.ts")],
        };
      }
      throw new Error(`unexpected tree path ${path}`);
    };
    setWorkspace(bundle, "C:/ws-a");
    mount(bundle);
    await until("root rows", () => assert.deepEqual(rowNames(), ["src", "a.txt"]));

    row("src").click();
    await until("expanded src", () => {
      assert.equal(row("src")?.getAttribute("aria-expanded"), "true");
      assert.ok(row("src/x.ts"));
    });

    secondPage = true;
    stub.calls.length = 0;
    q('button[aria-label="Refresh file tree"]').click();
    await until("refreshed children", () => {
      assert.ok(row("src/x.ts"));
      assert.ok(row("src/y.ts"), "new child appears after refresh");
      assert.equal(row("src")?.getAttribute("aria-expanded"), "true", "expanded folder stayed open");
    });
    const treeCalls = stub.calls.filter((call) => call.name === "tree").map((call) => call.args[0]);
    assert.deepEqual(treeCalls, ["", "src"], "refresh re-walks the root then the expanded directory, in order");
  });
});

test("capped and partially unreadable listings are stated at the root and per directory", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    const stub = globalThis.__ftStub;
    stub.calls.length = 0;
    stub.tree = async (path) => {
      if (!path) {
        return { path: "", entries: [dir("big")], truncated: true, limit: 400, unreadable: 1 };
      }
      if (path === "big") {
        return { path: "big", entries: [file("big/x.ts")], truncated: true, limit: 400, unreadable: 2 };
      }
      throw new Error(`unexpected tree path ${path}`);
    };
    setWorkspace(bundle, "C:/ws-a");
    mount(bundle);

    await until("root notice", () => {
      const text = qa(".ft-note").map((element) => element.textContent).join(" | ");
      assert.match(text, /first 400 entries/);
      assert.match(text, /1 entry could not be read/);
    });

    row("big").click();
    await until("directory notice", () => {
      assert.ok(row("big/x.ts"));
      const text = qa(".ft-note").map((element) => element.textContent).join(" | ");
      assert.match(text, /first 400 entries/);
      assert.match(text, /2 entries could not be read/);
    });
  });
});

test("re-expanding a loaded folder reuses its listing and the tree never polls", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    const stub = globalThis.__ftStub;
    stub.calls.length = 0;
    stub.tree = async (path) => {
      if (!path) return { path: "", entries: [dir("src"), file("a.txt")] };
      if (path === "src") return { path: "src", entries: [file("src/x.ts")] };
      throw new Error(`unexpected tree path ${path}`);
    };
    setWorkspace(bundle, "C:/ws-a");
    mount(bundle);
    await until("root rows", () => assert.deepEqual(rowNames(), ["src", "a.txt"]));

    row("src").click();
    await until("src expanded", () => assert.ok(row("src/x.ts")));
    row("src").click();
    await until("src collapsed", () => assert.equal(row("src")?.getAttribute("aria-expanded"), "false"));
    row("src").click();
    await until("src re-expanded without a new listing", () => {
      assert.equal(row("src")?.getAttribute("aria-expanded"), "true");
      assert.ok(row("src/x.ts"));
    });

    assert.equal(
      stub.calls.filter((call) => call.name === "tree" && call.args[0] === "src").length,
      1,
      "a loaded directory is listed exactly once across expand/collapse cycles",
    );
    // No interval/refresh loop: an idle tree issues no further filesystem work.
    const before = stub.calls.filter((call) => call.name === "tree").length;
    await sleep(200);
    assert.equal(stub.calls.filter((call) => call.name === "tree").length, before, "no background polling");
  });
});

test("the roving tab stop follows the tree when a refresh removes the focused path", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    const stub = globalThis.__ftStub;
    stub.calls.length = 0;
    let srcExists = true;
    stub.tree = async (path) => {
      if (!path) return { path: "", entries: srcExists ? [dir("src"), file("a.txt")] : [file("a.txt")] };
      if (path === "src") return { path: "src", entries: [file("src/x.ts")] };
      throw new Error(`unexpected tree path ${path}`);
    };
    setWorkspace(bundle, "C:/ws-a");
    mount(bundle);
    await until("root rows", () => assert.deepEqual(rowNames(), ["src", "a.txt"]));

    row("src").click();
    await until("src expanded", () => assert.ok(row("src/x.ts")));
    row("src/x.ts").focus();
    await until("child holds the tab stop", () => assert.equal(row("src/x.ts")?.tabIndex, 0));

    srcExists = false;
    q('button[aria-label="Refresh file tree"]').click();
    await until("focused folder vanished from the refreshed tree", () => assert.deepEqual(rowNames(), ["a.txt"]));
    assert.equal(row("a.txt")?.tabIndex, 0, "the first visible row becomes the tab stop");
    assert.equal(qa('.ft-row[tabindex="0"]').length, 1, "exactly one row is tabbable");
  });
});

test("a late tree response from the previous workspace is discarded", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    const stub = globalThis.__ftStub;
    stub.calls.length = 0;
    let resolveOld;
    let phase = "old";
    stub.tree = () => {
      if (phase === "old") return new Promise((resolve) => { resolveOld = resolve; });
      return Promise.resolve({ path: "", entries: [file("b.txt")] });
    };
    setWorkspace(bundle, "C:/ws-a");
    mount(bundle);
    await until("old load pending", () =>
      assert.match(q(".ft-empty")?.textContent ?? "", /Loading workspace/));

    phase = "new";
    setWorkspace(bundle, "C:/ws-b");
    await until("new workspace tree", () => assert.deepEqual(rowNames(), ["b.txt"]));

    resolveOld({ path: "", entries: [file("a.txt")] });
    await sleep(30);
    assert.deepEqual(rowNames(), ["b.txt"], "the stale response never enters the new tree");
    assert.equal(row("a.txt"), null);
  });
});

test("keyboard navigation moves focus, expands/collapses and activates rows", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    const stub = globalThis.__ftStub;
    stub.calls.length = 0;
    stub.tree = async (path) => {
      if (!path) return { path: "", entries: [dir("src"), file("a.txt")] };
      if (path === "src") return { path: "src", entries: [file("src/x.ts")] };
      throw new Error(`unexpected tree path ${path}`);
    };
    setWorkspace(bundle, "C:/ws-a");
    mount(bundle);
    await until("root rows", () => assert.deepEqual(rowNames(), ["src", "a.txt"]));

    const press = (path, key) => {
      const element = row(path);
      element.focus();
      element.dispatchEvent(new globalThis.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    };

    press("src", "ArrowDown");
    await until("focus a.txt", () => assert.equal(globalThis.document.activeElement, row("a.txt")));
    press("a.txt", "ArrowUp");
    await until("focus src", () => assert.equal(globalThis.document.activeElement, row("src")));

    press("src", "ArrowRight");
    await until("src expanded from keyboard", () => {
      assert.equal(row("src")?.getAttribute("aria-expanded"), "true");
      assert.ok(row("src/x.ts"));
    });
    assert.ok(stub.calls.some((call) => call.name === "tree" && call.args[0] === "src"));
    press("src", "ArrowRight");
    await until("focus first child", () => assert.equal(globalThis.document.activeElement, row("src/x.ts")));
    press("src/x.ts", "ArrowLeft");
    await until("focus parent", () => assert.equal(globalThis.document.activeElement, row("src")));
    press("src", "ArrowLeft");
    await until("src collapsed", () => assert.equal(row("src")?.getAttribute("aria-expanded"), "false"));
    assert.equal(row("src/x.ts"), null, "collapsed children are not focusable rows");

    // Phase 3Q-2b keyboard contract: Space previews without opening a tab,
    // Enter opens the selected file in an editor tab (a full read, not a
    // bounded preview).
    press("a.txt", " ");
    await until("Space previews the selected file", () =>
      assert.ok(stub.calls.some((call) => call.name === "filePreview" && call.args[0] === "a.txt")));
    press("a.txt", "Enter");
    await until("Enter opens the selected file in the editor", () =>
      assert.ok(stub.calls.some((call) => call.name === "fileText" && call.args[0] === "a.txt")));
  });
});

// ---------------------------------------------------------------------------
// Checkpoint 6 — verified agent writes drive the explorer.
// ---------------------------------------------------------------------------

const agentChange = (overrides = {}) => ({
  key: "t1:c1:src/new.ts",
  taskId: "t1",
  callId: "c1",
  actionId: "a1",
  tool: "write_file",
  path: "src/new.ts",
  workspace: "C:/ws-a",
  at: 1,
  ...overrides,
});

test("a verified agent write refreshes only its folder, marks the row and dedupes", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    const stub = globalThis.__ftStub;
    stub.calls.length = 0;
    bundle.setState({ agentChanges: [], agentChangeTick: 0 });
    let srcEntries = [file("src/x.ts")];
    stub.tree = async (path) => {
      if (!path) return { path: "", entries: [dir("src"), file("a.txt")] };
      if (path === "src") return { path: "src", entries: srcEntries };
      throw new Error(`unexpected tree path ${path}`);
    };
    setWorkspace(bundle, "C:/ws-a");
    mount(bundle);
    await until("root rows", () => assert.deepEqual(rowNames(), ["src", "a.txt"]));
    row("src").click();
    await until("src expanded", () => assert.ok(row("src/x.ts")));

    stub.calls.length = 0;
    srcEntries = [file("src/x.ts"), file("src/new.ts")];
    const change = agentChange();
    bundle.setState({ agentChanges: [change], agentChangeTick: 1 });

    await until("new row with agent marker", () => {
      assert.ok(row("src/new.ts"), "the new file appears after an agent write");
      assert.match(row("src/new.ts").className, /ft-row-agent/);
      assert.match(row("src/new.ts").getAttribute("aria-label"), /changed by the agent/);
      assert.ok(row("src/new.ts").querySelector(".ft-agent-dot"), "provenance marker is visible");
    });
    assert.deepEqual(
      stub.calls.filter((call) => call.name === "tree").map((call) => call.args[0]),
      ["src"],
      "only the containing directory is re-listed — never a full-tree walk",
    );
    assert.equal(row("src")?.getAttribute("aria-expanded"), "true", "expanded state survives");

    // A replay of the exact same task/call/path must not refresh again.
    bundle.setState({ agentChanges: [change], agentChangeTick: 2 });
    await sleep(80);
    assert.equal(
      stub.calls.filter((call) => call.name === "tree").length,
      1,
      "a replayed event is deduped",
    );

    // A verified change from another workspace must never touch this tree.
    bundle.setState({
      agentChanges: [change, agentChange({ key: "t2:c2:src/other.ts", taskId: "t2", callId: "c2", path: "src/other.ts", workspace: "C:/ws-b" })],
      agentChangeTick: 3,
    });
    await sleep(80);
    assert.equal(
      stub.calls.filter((call) => call.name === "tree").length,
      1,
      "another workspace's change is ignored",
    );
    assert.equal(row("src/other.ts"), null);
  });
});

test("verified agent writes reload clean tabs and preserve dirty drafts", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    const stub = globalThis.__ftStub;
    stub.calls.length = 0;
    bundle.setState({ agentChanges: [], agentChangeTick: 0 });
    stub.tree = async (path) => {
      if (!path) return { path: "", entries: [file("a.txt"), file("b.txt")] };
      throw new Error(`unexpected tree path ${path}`);
    };
    stub.fileText = async (path) => ({
      path,
      content: path === "a.txt" ? "agent text" : "new disk text",
      bytes: 0,
    });
    setWorkspace(bundle, "C:/ws-a");
    mount(bundle);
    await until("root rows", () => assert.deepEqual(rowNames(), ["a.txt", "b.txt"]));

    // Two open tabs: one clean (no unsaved work), one dirty.
    bundle.setState({
      editorDocs: [
        { path: "a.txt", original: "old", draft: "old" },
        { path: "b.txt", original: "b", draft: "mine" },
      ],
      editorActivePath: "a.txt",
      editorWorkspaceTag: "C:/ws-a",
      toasts: [],
    });
    bundle.setState({
      agentChanges: [
        agentChange({ key: "t1:c1:a.txt", path: "a.txt", tool: "edit_file" }),
        agentChange({ key: "t1:c2:b.txt", callId: "c2", path: "b.txt", tool: "write_file" }),
      ],
      agentChangeTick: 1,
    });

    await until("clean tab reloaded from disk", () => {
      const doc = bundle.getState().editorDocs.find((d) => d.path === "a.txt");
      assert.equal(doc.draft, "agent text");
      assert.equal(doc.original, "agent text");
    });
    const dirty = bundle.getState().editorDocs.find((d) => d.path === "b.txt");
    assert.equal(dirty.draft, "mine", "an unsaved draft is never replaced");
    assert.equal(dirty.original, "b", "its review baseline is not silently moved");
    assert.equal(bundle.getState().editorActivePath, "a.txt", "tab selection is unchanged");
    assert.equal(bundle.getState().editorDocs.length, 2, "no tab was closed or duplicated");
    assert.ok(
      bundle.getState().toasts.some((item) => /b\.txt changed on disk by the agent.*unsaved draft was kept/.test(item.text)),
      "the dirty tab's user is warned truthfully",
    );
  });
});

test("a root-level agent write refreshes the root without collapsing open folders", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    const stub = globalThis.__ftStub;
    stub.calls.length = 0;
    bundle.setState({ agentChanges: [], agentChangeTick: 0 });
    stub.tree = async (path) => {
      if (!path) return { path: "", entries: [dir("src"), file("a.txt")] };
      if (path === "src") return { path: "src", entries: [file("src/x.ts")] };
      throw new Error(`unexpected tree path ${path}`);
    };
    setWorkspace(bundle, "C:/ws-a");
    mount(bundle);
    await until("root rows", () => assert.deepEqual(rowNames(), ["src", "a.txt"]));
    row("src").click();
    await until("src expanded", () => assert.ok(row("src/x.ts")));

    stub.calls.length = 0;
    bundle.setState({
      agentChanges: [agentChange({ key: "t1:c9:a.txt", callId: "c9", tool: "edit_file", path: "a.txt" })],
      agentChangeTick: 1,
    });
    await until("root file marked", () => assert.match(row("a.txt")?.className ?? "", /ft-row-agent/));
    assert.deepEqual(
      stub.calls.filter((call) => call.name === "tree").map((call) => call.args[0]),
      [""],
      "a root-level change refreshes only the root listing",
    );
    assert.equal(row("src")?.getAttribute("aria-expanded"), "true", "the folder stays open");
    assert.ok(row("src/x.ts"), "loaded children were preserved by the root merge");
  });
});

// CP10 integration defect: verified writes that arrive while the Files surface
// is unmounted (the user is in chat) used to be marked as "already handled" on
// remount, so the explorer and clean tabs never reconciled them. The handling
// state now lives in the session store, which makes the remount process exactly
// the changes it missed without replaying the ones it already applied.
test("a verified agent write received while Files is unmounted is reconciled on return", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    const stub = globalThis.__ftStub;
    stub.calls.length = 0;
    let rootEntries = [file("a.txt")];
    stub.tree = async (path) => {
      if (!path) return { path: "", entries: rootEntries };
      throw new Error(`unexpected tree path ${path}`);
    };
    stub.fileText = async (path) => ({ path, content: "agent text", bytes: 10 });

    setWorkspace(bundle, "C:/ws-a");
    bundle.setState({
      editorDocs: [{ path: "a.txt", original: "old", draft: "old" }],
      editorActivePath: "a.txt",
      editorWorkspaceTag: "C:/ws-a",
    });
    mount(bundle);
    await until("root row before leaving Files", () => assert.deepEqual(rowNames(), ["a.txt"]));

    // The user leaves the Files surface; its component (and refs) unmount.
    unmountAll();

    // While they are in chat, two verified writes arrive: one changes the open
    // CLEAN document, the other creates a new file that must get its marker.
    rootEntries = [file("a.txt"), file("new.txt")];
    bundle.setState({
      agentChanges: [
        agentChange({ key: "t1:c1:a.txt", callId: "c1", actionId: "a1", path: "a.txt", tool: "edit_file" }),
        agentChange({ key: "t1:c2:new.txt", callId: "c2", actionId: "a2", path: "new.txt", tool: "write_file" }),
      ],
      agentChangeTick: 1,
    });

    // Returning to Files must reconcile both, not discard them as historical.
    mount(bundle);
    await until("the new file appears with agent provenance", () => {
      assert.ok(row("new.txt"), "the missed write is visible in the tree");
      assert.match(row("new.txt").className, /ft-row-agent/);
      assert.ok(row("new.txt").querySelector(".ft-agent-dot"));
    });
    await until("the clean tab reloads the missed write", () => {
      const doc = bundle.getState().editorDocs.find((d) => d.path === "a.txt");
      assert.equal(doc.draft, "agent text");
      assert.equal(doc.original, "agent text");
    });

    // Once reconciled, a replay of the same events must not refresh again.
    const treeCalls = stub.calls.filter((call) => call.name === "tree").length;
    bundle.setState({ agentChangeTick: 2 });
    await sleep(100);
    assert.equal(stub.calls.filter((call) => call.name === "tree").length, treeCalls, "handled keys survive the remount and dedupe replays");
  });
});

// ---------------------------------------------------------------------------
// Phase 3Q-2b — interaction-first file workspace.
// ---------------------------------------------------------------------------

const previewOf = (path) => ({
  path, content: `disk:${path}`, offset: 0, line_limit: 300, size_bytes: 12, has_more: false,
});

const click = (element) => element.dispatchEvent(new globalThis.MouseEvent("click", { bubbles: true, cancelable: true }));
const dblclick = (element) => element.dispatchEvent(new globalThis.MouseEvent("dblclick", { bubbles: true, cancelable: true }));
const contextMenu = (element) => element.dispatchEvent(new globalThis.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 20 }));
const key = (element, k) => element.dispatchEvent(new globalThis.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

const noWrites = (stub) => assert.equal(stub.calls.filter((c) => c.name === "fileSave").length, 0, "no file write was attempted");

/** Activate a tab by its visible label (the Tabs primitive renders buttons). */
function clickTab(label) {
  const tab = qa('[role="tab"]').find((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim().startsWith(label));
  assert.ok(tab, `tab ${label} exists`);
  click(tab);
}

test("single click selects a row and previews it inline, never in a modal", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    const stub = globalThis.__ftStub;
    stub.calls.length = 0;
    stub.tree = async () => ({ path: "", entries: [file("a.txt"), file("b.txt")] });
    stub.filePreview = async (path) => previewOf(path);
    setWorkspace(bundle, "C:/ws");
    mount(bundle);
    await until("rows", () => assert.deepEqual(rowNames(), ["a.txt", "b.txt"]));

    click(row("a.txt"));
    await until("inline preview of the clicked file", () => {
      assert.equal(q(".file-preview-pane")?.getAttribute("aria-label"), "Preview of a.txt");
      assert.equal(q(".file-preview-content")?.textContent, "disk:a.txt");
    });
    assert.equal(q(".modal"), null, "no modal interrupts the file workflow");
    assert.equal(row("a.txt").getAttribute("aria-selected"), "true", "selection stays visible while previewing");
    assert.match(row("a.txt").className, /ft-row-selected/);
    assert.ok(q(".file-preview-head").textContent.includes("a.txt"), "the pane names the file");
    assert.ok(/on disk/.test(q(".file-preview-head").textContent), "the preview is labelled a disk copy");
    assert.ok(q(".fw-editor-title").textContent.includes("on disk"), "and the workspace title says so too");
    assert.ok(!stub.calls.some((c) => c.name === "fileText"), "a preview does not open an editor tab");
    noWrites(stub);
  });
});

test("double-click and Enter open one tab, and reopening never duplicates it", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    const stub = globalThis.__ftStub;
    stub.calls.length = 0;
    stub.tree = async () => ({ path: "", entries: [file("a.txt"), file("b.txt"), file("c.txt")] });
    stub.filePreview = async (path) => previewOf(path);
    stub.fileText = async (path) => ({ path, content: `text:${path}`, bytes: 10 });
    setWorkspace(bundle, "C:/ws");
    mount(bundle);
    await until("rows", () => assert.deepEqual(rowNames(), ["a.txt", "b.txt", "c.txt"]));

    dblclick(row("a.txt"));
    await until("a.txt tab opened", () => {
      assert.equal(bundle.getState().editorDocs.length, 1);
      assert.equal(bundle.getState().editorActivePath, "a.txt");
    });
    assert.equal(bundle.getState().editorDocs[0].draft, "text:a.txt");

    // A preview of an UNOPENED file leaves the open document untouched.
    click(row("c.txt"));
    await until("c.txt preview", () => assert.equal(q(".file-preview-content")?.textContent, "disk:c.txt"));
    assert.equal(bundle.getState().editorDocs.length, 1, "previewing does not close or replace the tab");
    assert.equal(bundle.getState().editorDocs[0].path, "a.txt");

    // Selecting an OPEN file shows its tab instead of a second preview surface.
    click(row("a.txt"));
    await until("the open document is shown, not re-previewed", () => {
      assert.equal(q(".file-preview-pane"), null);
      assert.equal(bundle.getState().editorActivePath, "a.txt");
    });

    // Re-opening the same file activates the existing tab instead of adding one.
    key(row("a.txt"), "Enter");
    await until("the preview closes and the existing tab is active", () => {
      assert.equal(bundle.getState().editorDocs.length, 1);
      assert.equal(bundle.getState().editorActivePath, "a.txt");
      assert.equal(q(".file-preview-pane"), null);
    });
    assert.equal(stub.calls.filter((c) => c.name === "fileText").length, 1, "no duplicate read or tab");
    noWrites(stub);
  });
});

test("Space previews without opening a tab", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    const stub = globalThis.__ftStub;
    stub.calls.length = 0;
    stub.tree = async () => ({ path: "", entries: [file("a.txt")] });
    stub.filePreview = async (path) => previewOf(path);
    setWorkspace(bundle, "C:/ws");
    mount(bundle);
    await until("rows", () => assert.deepEqual(rowNames(), ["a.txt"]));

    key(row("a.txt"), " ");
    await until("preview from Space", () => assert.equal(q(".file-preview-content")?.textContent, "disk:a.txt"));
    assert.equal((bundle.getState().editorDocs ?? []).length, 0, "Space does not create a document");
    assert.ok(!stub.calls.some((c) => c.name === "fileText"));

    // Space again toggles the same preview off.
    key(row("a.txt"), " ");
    await until("preview toggled off", () => assert.equal(q(".file-preview-pane"), null));
    noWrites(stub);
  });
});

test("the context menu offers only real actions, supports the keyboard and copies a path", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    const stub = globalThis.__ftStub;
    stub.calls.length = 0;
    stub.tree = async () => ({ path: "", entries: [file("a.txt")] });
    stub.filePreview = async (path) => previewOf(path);
    let copied = null;
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text) => { copied = text; } },
    });
    setWorkspace(bundle, "C:/ws");
    bundle.setState({ settings: { explorer_width: 272, theme: "dark" } });
    mount(bundle);
    await until("rows", () => assert.deepEqual(rowNames(), ["a.txt"]));

    contextMenu(row("a.txt"));
    await until("menu opened with real actions", () => {
      assert.equal(q('[role="menu"]')?.getAttribute("aria-label"), "File actions");
      assert.deepEqual(qa('[role="menuitem"]').map((b) => b.textContent), [
        "Open in editor", "Preview", "Copy relative path", "Copy absolute path", "Share with chat",
      ]);
    });
    await until("the menu takes focus", () =>
      assert.equal(globalThis.document.activeElement, q('[role="menu"]')));

    key(q('[role="menu"]'), "ArrowDown");
    await until("roving focus moves", () => {
      assert.equal(qa('[role="menuitem"]').findIndex((b) => b.className.includes("ft-menu-active")), 1);
    });
    key(q('[role="menu"]'), "Escape");
    await until("Escape closes the menu", () => assert.equal(q('[role="menu"]'), null));

    // Shift+F10 is the keyboard route to the same menu.
    key(row("a.txt"), "F10");
    assert.equal(q('[role="menu"]'), null, "F10 alone is not the menu key");
    row("a.txt").dispatchEvent(new globalThis.KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }));
    await until("Shift+F10 opens the menu", () => assert.ok(q('[role="menu"]')));

    // Home then two downs lands on "Copy relative path" (each key needs its
    // own render tick, exactly as a real keyboard produces them).
    key(q('[role="menu"]'), "Home");
    await until("Home focuses the first item", () =>
      assert.equal(qa('[role="menuitem"]').findIndex((b) => b.className.includes("ft-menu-active")), 0));
    key(q('[role="menu"]'), "ArrowDown");
    await until("second item focused", () =>
      assert.equal(qa('[role="menuitem"]').findIndex((b) => b.className.includes("ft-menu-active")), 1));
    key(q('[role="menu"]'), "ArrowDown");
    await until("copy-relative focused", () =>
      assert.equal(qa('[role="menuitem"]').findIndex((b) => b.className.includes("ft-menu-active")), 2));
    key(q('[role="menu"]'), "Enter");
    await until("relative path copied", () => assert.equal(copied, "a.txt"));
    assert.equal(q('[role="menu"]'), null, "picking an action closes the menu");
    assert.ok(bundle.getState().toasts?.length > 0, "the copy is reported to the user");
    noWrites(stub);
  });
});

test("sharing an unopened file reads disk and labels the attachment on-disk", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    const stub = globalThis.__ftStub;
    stub.calls.length = 0;
    stub.tree = async () => ({ path: "", entries: [file("a.txt")] });
    stub.filePreview = async (path) => previewOf(path);
    stub.fileText = async (path) => ({ path, content: `text:${path}`, bytes: 10 });
    setWorkspace(bundle, "C:/ws");
    mount(bundle);
    await until("rows", () => assert.deepEqual(rowNames(), ["a.txt"]));

    click(row("a.txt"));
    await until("preview loaded", () => assert.ok(q(".file-preview-content")));
    click(qa(".file-preview-actions button").find((b) => /Share with chat/.test(b.textContent)));
    await until("editor context attached", () => assert.equal(bundle.getState().editorContexts?.length, 1));

    const item = bundle.getState().editorContexts[0];
    assert.equal(item.path, "a.txt");
    assert.equal(item.workspace, "C:/ws");
    assert.equal(item.origin, "disk", "an unopened file is shared from disk");
    assert.equal(item.unsaved, false);
    assert.equal(item.text, "text:a.txt", "the share uses the freshly read disk text");
    assert.equal(bundle.getState().view, "chat", "sharing routes to the composer to review it");
    assert.ok(stub.calls.some((c) => c.name === "fileText" && c.args[0] === "a.txt"), "disk is read at share time");
    noWrites(stub);
  });
});

test("a shared open tab uses its current draft, not the disk copy", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    const stub = globalThis.__ftStub;
    stub.calls.length = 0;
    stub.tree = async () => ({ path: "", entries: [file("a.txt")] });
    stub.filePreview = async (path) => previewOf(path);
    stub.fileText = async (path) => ({ path, content: "text:a.txt", bytes: 10 });
    setWorkspace(bundle, "C:/ws");
    mount(bundle);
    await until("rows", () => assert.deepEqual(rowNames(), ["a.txt"]));

    dblclick(row("a.txt"));
    await until("tab opened", () => assert.equal(bundle.getState().editorDocs.length, 1));
    bundle.setState({ editorDocs: [{ path: "a.txt", original: "text:a.txt", draft: "unsaved edit" }] });
    click(row("a.txt"));
    await until("the title names the unsaved draft", () => {
      assert.equal(bundle.getState().editorActivePath, "a.txt");
      assert.ok(q(".fw-editor-title").textContent.includes("unsaved draft"));
    });

    // The header share resolves the selection: an open document shares its draft.
    const readCalls = stub.calls.filter((c) => c.name === "fileText").length;
    click(qa(".ft-head-actions button")[0]);
    await until("draft attached", () => {
      assert.equal(bundle.getState().editorContexts?.length, 1);
      assert.equal(bundle.getState().editorContexts[0].origin, "draft");
    });

    const item = bundle.getState().editorContexts[0];
    assert.equal(item.origin, "draft");
    assert.equal(item.unsaved, true);
    assert.equal(item.text, "unsaved edit", "the unsaved buffer is shared as-is");
    assert.equal(stub.calls.filter((c) => c.name === "fileText").length, readCalls, "no disk re-read for a draft");
    noWrites(stub);
  });
});

test("the explorer splitter restores its width, resizes by keyboard and persists once", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    const stub = globalThis.__ftStub;
    stub.calls.length = 0;
    stub.tree = async () => ({ path: "", entries: [file("a.txt")] });
    stub.filePreview = async (path) => previewOf(path);
    setWorkspace(bundle, "C:/ws");
    bundle.setState({ settings: { explorer_width: 300, theme: "dark", font_size: 14 } });
    mount(bundle);
    await until("restored explorer width", () =>
      assert.match(q(".fw-explorer").getAttribute("style"), /width: 300px/));

    const split = q(".fw-split");
    assert.ok(split, "the explorer/editor boundary is a real splitter");
    assert.equal(split.getAttribute("role"), "separator");
    assert.equal(split.getAttribute("aria-orientation"), "vertical");
    assert.equal(split.getAttribute("aria-label"), "Resize file explorer");
    assert.equal(split.getAttribute("aria-valuenow"), "300");
    assert.equal(split.getAttribute("tabindex"), "0");

    key(split, "ArrowRight");
    await until("keyboard resize widens the explorer", () =>
      assert.match(q(".fw-explorer").getAttribute("style"), /width: 316px/));
    await until("the new width is persisted", () => {
      const call = stub.calls.filter((c) => c.name === "settingsSet").at(-1);
      assert.ok(call, "settingsSet was called");
      assert.equal(call.args[0].explorer_width, 316);
      assert.equal(call.args[0].theme, "dark", "unrelated settings are sent back untouched");
    });
    assert.equal(stub.calls.filter((c) => c.name === "settingsSet").length, 1, "one commit per gesture");

    key(split, "End");
    await until("End jumps to the maximum", () =>
      assert.equal(q(".fw-split").getAttribute("aria-valuenow"), "440"));
    noWrites(stub);
  });
});

test("an out-of-range persisted width is clamped instead of breaking the layout", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    const stub = globalThis.__ftStub;
    stub.calls.length = 0;
    stub.tree = async () => ({ path: "", entries: [] });
    setWorkspace(bundle, "C:/ws");
    bundle.setState({ settings: { explorer_width: 9999, theme: "dark" } });
    mount(bundle);
    await until("clamped width", () => {
      const width = Number(/width: (\d+)px/.exec(q(".fw-explorer").getAttribute("style"))[1]);
      assert.equal(width, 440, "the editor keeps its minimum width");
      assert.equal(q(".fw-split").getAttribute("aria-valuenow"), "440");
    });
  });
});

test("selecting, previewing and switching tabs never writes a file", async () => {
  await withDom(async () => {
    const bundle = await loadBundle();
    const stub = globalThis.__ftStub;
    stub.calls.length = 0;
    stub.tree = async () => ({ path: "", entries: [file("a.txt"), file("b.txt"), file("c.txt")] });
    stub.filePreview = async (path) => previewOf(path);
    stub.fileText = async (path) => ({ path, content: `text:${path}`, bytes: 10 });
    setWorkspace(bundle, "C:/ws");
    mount(bundle);
    await until("rows", () => assert.deepEqual(rowNames(), ["a.txt", "b.txt", "c.txt"]));

    click(row("a.txt"));
    await until("preview a", () => assert.ok(q(".file-preview-pane")));
    dblclick(row("a.txt"));
    await until("tab a", () => assert.equal(bundle.getState().editorDocs.length, 1));
    bundle.setState({ editorDocs: [{ path: "a.txt", original: "text:a.txt", draft: "dirty draft" }] });
    dblclick(row("b.txt"));
    await until("tab b", () => assert.equal(bundle.getState().editorDocs.length, 2));

    // Switching tabs never discards the other draft.
    clickTab("a.txt");
    await until("draft a preserved", () =>
      assert.equal(bundle.getState().editorDocs.find((d) => d.path === "a.txt").draft, "dirty draft"));

    // A dirty tab must not block previewing another (unopened) file.
    click(row("c.txt"));
    await until("preview while a dirty tab exists", () =>
      assert.equal(q(".file-preview-pane")?.getAttribute("aria-label"), "Preview of c.txt"));
    assert.equal(bundle.getState().editorDocs.find((d) => d.path === "a.txt").draft, "dirty draft");
    assert.equal(bundle.getState().editorDocs.length, 2, "both documents stay open while previewing");
    noWrites(stub);
  });
});
