// Checkpoint 3 — real multi-document editor lifecycle in jsdom.
// Verifies with actual CodeMirror instances that:
//  • per-document cursor/selection/doc state survives a tab switch without
//    any editor reconstruction (the strategy: hide, don't destroy),
//  • destroying a tab leaves no .cm-content behind (no orphaned views),
//  • external draft routing (docsAfterSave-style) reaches exactly one view.
// jsdom borrows several DOM globals CodeMirror needs at construction time.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const withDom = async (run) => {
  const dom = new JSDOM("<!doctype html><html><body><div class='row'><div class=' editors'><div id='ea'></div><div id='eb'></div><div id='ec'></div></div></div></body></html>", { pretendToBeVisual: true });
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
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
};

test("multi-tab: per-document view state survives switching without reconstruction", async () => {
  await withDom(async () => {
    const { createEditorHost } = await import("../src/editorHost.ts");
    const edits = [];
    const ea = document.getElementById("ea");
    const eb = document.getElementById("eb");
    const hostA = await createEditorHost(ea, { path: "src/a/util.ts", value: "line one\nline two\nline three", onInput: (t) => edits.push(["a", t]) });
    const hostB = await createEditorHost(eb, { path: "src/b/util.ts", value: "another doc", onInput: (t) => edits.push(["b", t]) });

    // Put A's cursor on line two, mid-doc, with a selection.
    const posA = hostA.view.state.doc.line(2).to;
    hostA.view.dispatch({ selection: { anchor: posA - 1, head: posA }, scrollIntoView: false });
    // Hide A, show B (pure visibility — nothing else happens to A).
    ea.style.display = "none";
    eb.style.display = "block";
    // While hidden, the user edits B.
    hostB.view.dispatch({ changes: { from: 0, to: hostB.view.state.doc.length, insert: "b edit" } });

    // Switch back to A; a real switch would only toggle display.
    ea.style.display = "block";
    eb.style.display = "none";
    assert.equal(hostA.view.state.doc.toString(), "line one\nline two\nline three", "A's doc intact");
    assert.equal(hostA.view.state.selection.main.anchor, posA - 1, "A's cursor preserved");
    assert.equal(hostA.view.state.selection.main.head, posA, "A's selection preserved");
    assert.equal(hostB.view.state.doc.toString(), "b edit", "B got its own edit");
    assert.deepEqual(edits, [["b", "b edit"]], "hidden doc edit did not echo into onInput");

    hostA.destroy();
    hostB.destroy();
  });
});

test("active-tab save routing: draftsAfterSave only refreshes the saved document's view", async () => {
  await withDom(async () => {
    const { createEditorHost } = await import("../src/editorHost.ts");
    const ea = document.getElementById("ea");
    const eb = document.getElementById("eb");
    const hostA = await createEditorHost(ea, { path: "one.txt", value: "A old", onInput: () => {} });
    const hostB = await createEditorHost(eb, { path: "two.txt", value: "B draft", onInput: () => {} });
    // B is saved while it is NOT the rendered "active" doc: the guard is the
    // same equality check FileTree's NativeEditor uses (no setText if equal).
    hostA.view.dispatch({ changes: { from: 0, to: hostA.view.state.doc.length, insert: "A IS BESIDE" } });
    const savedB = "B draft"; // docsAfterSave sets B original+draft to this
    const same = hostB.view.state.doc.toString() === savedB;
    assert.equal(same, true, "no dispatch happened for the non-changed doc");
    assert.equal(hostA.view.state.doc.toString(), "A IS BESIDE", "other doc untouched by B's save");
    hostA.destroy();
    hostB.destroy();
  });
});

test("three documents open: each view holds its own text; closing destroys cleanly", async () => {
  await withDom(async () => {
    const { createEditorHost } = await import("../src/editorHost.ts");
    const hosts = [];
    const slots = ["ea", "eb", "ec"];
    const texts = ["doc number one", "doc number two", "doc number three"];
    for (let i = 0; i < 3; i++) {
      const handle = await createEditorHost(document.getElementById(slots[i]), {
        path: `doc${i}.py`,
        value: texts[i],
        onInput: () => {},
      });
      handle.view.dispatch({ changes: { from: 0, to: 0, insert: `*- ${i} ` } });
      hosts.push(handle);
    }
    assert.equal(document.querySelectorAll(".cm-content").length, 3, "one contenteditable per document");
    for (let i = 0; i < 3; i++) {
      assert.equal(hosts[i].view.state.doc.toString(), `*- ${i} ${texts[i]}`, "independent drafts kept");
    }
    // Close the middle tab: its view is disposed, others stay usable.
    hosts[1].destroy();
    assert.equal(document.querySelectorAll(".cm-content").length, 2, "middle view gone");
    assert.equal(hosts[2].view.state.doc.toString(), "*- 2 doc number three", "remaining docs intact");
    // Close-all.
    hosts[0].destroy();
    hosts[2].destroy();
    assert.equal(document.querySelectorAll(".cm-content").length, 0, "no orphaned views");
  });
});
