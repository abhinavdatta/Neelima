// Phase 3Q-2a — the `Tabs` primitive rendered for real.
//
// The extraction from FileTree's inline `EditorTabs` is only safe if the
// emitted DOM and the interactions are unchanged, so this mounts the actual
// component and checks structure, ARIA, classes, activation and closing.
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
const outdir = join(repoDir, ".tmp", "3q2a-tabs");
const outfile = join(outdir, "bundle.cjs");

let mod = null;

async function load() {
  if (mod) return mod;
  mkdirSync(outdir, { recursive: true });
  await esbuild.build({
    stdin: {
      contents: `export { Tabs } from "./src/components/ui/Tabs.tsx";\nexport { h, render } from "preact";`,
      loader: "js",
      resolveDir: uiDir,
    },
    absWorkingDir: uiDir,
    tsconfig: join(uiDir, "tsconfig.json"),
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile,
    define: { "process.env.NODE_ENV": '"test"' },
    logLevel: "silent",
  });
  mod = createRequire(import.meta.url)(outfile);
  return mod;
}

const GLOBALS = ["document", "window", "Node", "Element", "HTMLElement", "KeyboardEvent", "MouseEvent", "Event"];

async function withDom(run) {
  const { Tabs, h, render } = await load();
  const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { pretendToBeVisual: true });
  const previous = {};
  for (const key of GLOBALS) {
    previous[key] = globalThis[key];
    globalThis[key] = dom.window[key];
  }
  const root = dom.window.document.getElementById("root");
  const calls = [];
  const items = [
    { id: "src/app.ts", label: "app.ts", title: "src/app.ts", dirty: false },
    { id: "src/beta.ts", label: "beta.ts", title: "src/beta.ts — unsaved changes", dirty: true },
  ];
  render(
    h(Tabs, {
      ariaLabel: "Open documents",
      active: "src/app.ts",
      items,
      onActivate: (id) => calls.push(["activate", id]),
      onClose: (id) => calls.push(["close", id]),
    }),
    root,
  );
  try {
    await run({ doc: dom.window.document, root, calls });
  } finally {
    render(null, root);
    for (const key of GLOBALS) {
      if (previous[key] === undefined) delete globalThis[key];
      else globalThis[key] = previous[key];
    }
  }
}

test("the strip is a labelled tablist of real tabs", async () => {
  await withDom(async ({ doc }) => {
    const strip = doc.querySelector(".editor-tabs");
    assert.ok(strip, "strip element");
    assert.equal(strip.getAttribute("role"), "tablist");
    assert.equal(strip.getAttribute("aria-label"), "Open documents");
    const tabs = [...doc.querySelectorAll('[role="tab"]')];
    assert.equal(tabs.length, 2);
    assert.deepEqual(tabs.map((t) => t.querySelector(".editor-tab-name").textContent), ["app.ts", "beta.ts"]);
  });
});

test("active, idle and dirty states are distinguishable and independent", async () => {
  await withDom(async ({ doc }) => {
    const [first, second] = [...doc.querySelectorAll(".editor-tab")];
    assert.equal(first.className, "editor-tab editor-tab-active");
    assert.equal(second.className, "editor-tab editor-tab-idle editor-tab-dirty");
    assert.equal(first.getAttribute("aria-selected"), "true");
    assert.equal(second.getAttribute("aria-selected"), "false");
    assert.equal(first.getAttribute("tabindex"), "0");
    assert.equal(doc.querySelectorAll(".editor-tab-dot").length, 1);
    assert.equal(second.getAttribute("title"), "src/beta.ts — unsaved changes");
  });
});

test("close control names the file and mentions an unsaved draft", async () => {
  await withDom(async ({ doc }) => {
    const [first, second] = [...doc.querySelectorAll(".editor-tab-close")];
    assert.equal(first.getAttribute("aria-label"), "Close app.ts");
    assert.equal(second.getAttribute("aria-label"), "Close beta.ts (unsaved changes)");
    assert.equal(first.getAttribute("title"), "Close tab");
  });
});

test("clicking a tab activates it; clicking × closes without activating", async () => {
  await withDom(async ({ doc, calls }) => {
    doc.querySelectorAll(".editor-tab")[1].dispatchEvent(new doc.defaultView.MouseEvent("click", { bubbles: true }));
    assert.deepEqual(calls, [["activate", "src/beta.ts"]]);
    calls.length = 0;
    doc.querySelectorAll(".editor-tab-close")[0].dispatchEvent(new doc.defaultView.MouseEvent("click", { bubbles: true }));
    assert.deepEqual(calls, [["close", "src/app.ts"]], "the close click must not also activate the tab");
  });
});

test("Enter and Space activate, and other keys do not", async () => {
  await withDom(async ({ doc, calls }) => {
    const second = doc.querySelectorAll(".editor-tab")[1];
    const key = (k) => second.dispatchEvent(new doc.defaultView.KeyboardEvent("keydown", { key: k, bubbles: true }));
    key("ArrowRight");
    assert.deepEqual(calls, [], "arrow keys are a 3Q-4 concern, not activated here");
    key("Enter");
    key(" ");
    assert.deepEqual(calls, [["activate", "src/beta.ts"], ["activate", "src/beta.ts"]]);
  });
});

test("without onClose no close control is rendered", async () => {
  const { Tabs, h, render } = await load();
  const dom = new JSDOM("<!doctype html><html><body><div id=r></div></body></html>");
  const previous = {};
  for (const key of GLOBALS) { previous[key] = globalThis[key]; globalThis[key] = dom.window[key]; }
  const root = dom.window.document.getElementById("r");
  render(h(Tabs, { ariaLabel: "x", active: "a", items: [{ id: "a", label: "a" }], onActivate: () => {} }), root);
  try {
    assert.equal(dom.window.document.querySelectorAll(".editor-tab-close").length, 0);
    assert.equal(dom.window.document.querySelectorAll(".editor-tab").length, 1);
  } finally {
    render(null, root);
    for (const key of GLOBALS) { if (previous[key] === undefined) delete globalThis[key]; else globalThis[key] = previous[key]; }
  }
});
