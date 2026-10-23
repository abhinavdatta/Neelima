// Frontend rendering test: the wait card must show the provider's real
// lifecycle state, the rejection note, and stop showing a bare spinner.
// The component is bundled with the project's own esbuild and rendered with
// Preact into jsdom — no extra dependency.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { buildSync } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;

const build = buildSync({
  stdin: {
    contents: `
      import { render, h } from "preact";
      import { ProviderWaitCard } from "./src/components/Chat.tsx";
      import { setState } from "./src/store.ts";
      export { render, h, ProviderWaitCard, setState };
    `,
    resolveDir: join(here, ".."),
    sourcefile: "provider-wait-card-entry.tsx",
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "browser",
  jsx: "automatic",
  jsxImportSource: "preact",
  define: { "process.env.NODE_ENV": '"test"' },
  logLevel: "silent",
});

const bundle = build.outputFiles[0].text;
const mod = { exports: {} };
new Function("module", "exports", "require", bundle)(mod, mod.exports, require);
const { render, h, ProviderWaitCard, setState } = mod.exports;

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

test("the wait card renders the real request state and a rejection note", async () => {
  const root = document.getElementById("root");
  const mount = () => render(h(ProviderWaitCard, {}), root);
  try {
    setState({
      agentState: "waiting_for_ai",
      providerSelected: "web:chatgpt",
      providers: { web: [{ id: "chatgpt", name: "ChatGPT" }] },
      providerRequest: { requestId: "r1", provider: "chatgpt", state: "submitted", at: 0 },
      providerEventNote: null,
      taskId: "t1",
    });
    mount();
    await tick();
    assert.match(root.textContent, /Waiting for ChatGPT/);
    assert.match(root.textContent, /Request: submitted/);
    assert.match(root.textContent, /chatgpt/, "provider id is shown next to the state");

    // Remount after the state change: this is deterministic and does not
    // depend on when Preact flushes the store subscription effect.
    setState({
      providerRequest: { requestId: "r1", provider: "chatgpt", state: "timed_out", at: 10 },
      providerEventNote: "A provider reply #4 was rejected: stale request (reply belongs to an earlier send).",
    });
    render(null, root);
    mount();
    await tick();
    assert.match(root.textContent, /Request: timed out/, "terminal state is rendered");
    assert.match(root.textContent, /reply #4 was rejected/, "rejected push is explained");
  } finally {
    render(null, root);
    await tick();
  }
});

test("local providers get the same wait card, with local-appropriate actions", async () => {
  const root = document.getElementById("root");
  const mount = () => render(h(ProviderWaitCard, {}), root);
  try {
    setState({
      agentState: "waiting_for_ai",
      providerSelected: "ollama",
      providers: { web: [] },
      providerRequest: { requestId: "t1.abc", provider: "ollama", state: "submitted", at: 0 },
      providerEventNote: null,
      taskId: "t1",
    });
    mount();
    await tick();
    assert.match(root.textContent, /Waiting for Ollama/, "the card is no longer web-only");
    assert.match(root.textContent, /Request: submitted/);
    assert.match(root.textContent, /Open Settings/, "local providers open Settings, not a webview");
    assert.doesNotMatch(root.textContent, /Open provider window/, "no webview action for local runtimes");
    assert.doesNotMatch(root.textContent, /Capture current reply/, "capture is a web-page tool");

    setState({
      providerSelected: "lmstudio",
      providerRequest: { requestId: "t2.abc", provider: "lmstudio", state: "timed_out", at: 10 },
    });
    render(null, root);
    mount();
    await tick();
    assert.match(root.textContent, /Waiting for LM Studio/);
    assert.match(root.textContent, /Request: timed out/, "local timeouts are visible, not silent");
  } finally {
    render(null, root);
    await tick();
  }
});
