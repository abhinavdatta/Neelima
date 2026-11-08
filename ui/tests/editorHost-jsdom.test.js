// Editor host lifecycle smoke test under jsdom: create, edit, external sync,
// destroy. Globals must exist before any CodeMirror module loads, so all CM
// imports are dynamic inside createEditorHost (the pure setup module is dynamic
// too); that lets this test set the jsdom window first.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

async function withDom(run) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  // CodeMirror touches DOM APIs Node does not provide; borrow them from jsdom.
  const borrowed = [];
  for (const key of [
    "MutationObserver", "Range", "InputEvent", "Selection", "KeyboardEvent", "MouseEvent",
    "CustomEvent", "Element", "Node", "HTMLElement", "CharacterData", "Text", "DOMParser",
    "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "CSSStyleDeclaration",
  ]) {
    if (dom.window[key] !== undefined && globalThis[key] === undefined) {
      globalThis[key] = dom.window[key];
      borrowed.push(key);
    }
  }
  try {
    await run(dom);
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    for (const key of borrowed) delete globalThis[key];
  }
}

test("editor host: creates one view, syncs externally without echo, destroys clean", async () => {
  await withDom(async (dom) => {
    const { createEditorHost } = await import("../src/editorHost.ts");
    const document = dom.window.document;
    const host = document.createElement("div");
    document.body.appendChild(host);

    const onInput = [];
    const handle = await createEditorHost(host, {
      path: "calculator.py",
      value: "def add(a, b):\n    return a + b\n",
      onInput: (text) => onInput.push(text),
    });

    // One view, one content editable, language id resolved (python).
    assert.equal(handle.view.state.doc.toString(), "def add(a, b):\n    return a + b\n");
    assert.ok(handle.view.state.doc.lines >= 2);
    assert.ok(document.querySelectorAll(".cm-content").length === 1, "single content element");
    assert.equal(handle.languageId, "python");
    const content = host.querySelector(".cm-content");
    assert.equal(content.getAttribute("aria-label"), "Editing calculator.py");

    // External value sync never echoes back as a user edit.
    handle.setText("// reverted\n");
    assert.deepEqual(onInput, [], "external setText must not call onInput");
    assert.equal(handle.view.state.doc.toString(), "// reverted\n");

    // A genuine user edit (dispatch = what typing produces) reports the text.
    handle.view.dispatch({ changes: { from: 0, insert: "# hi\n" } });
    assert.deepEqual(onInput, ["# hi\n// reverted\n"]);

    // Destroy leaves no DOM, no retained document.
    handle.destroy();
    assert.equal(host.innerHTML, "");
    assert.equal(document.querySelectorAll(".cm-content").length, 0);
  });
});

test("editor host: read-only view exposes a non-editable content", async () => {
  await withDom(async (dom) => {
    const { createEditorHost } = await import("../src/editorHost.ts");
    const document = dom.window.document;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const handle = await createEditorHost(host, {
      path: "x.js",
      value: "const a = 1;\n",
      readOnly: true,
      onInput: () => assert.fail("read-only editor must not report edits"),
    });
    const content = host.querySelector(".cm-content");
    assert.ok(content, "content element exists in read-only mode");
    assert.match(content.getAttribute("aria-label"), /Editing x\.js/);
    handle.destroy();
    assert.equal(document.querySelectorAll(".cm-content").length, 0);
  });
});
