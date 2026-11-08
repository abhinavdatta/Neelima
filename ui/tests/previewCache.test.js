// Phase 3Q-2b — selection-driven preview reads: debounce, cache, invalidation
// and stale-response discard. Pure module, so time and reads are injected.
import test from "node:test";
import assert from "node:assert/strict";
import { createPreviewController, PREVIEW_DEBOUNCE_MS } from "../src/previewCache.ts";

const page = (path, content, extra = {}) => ({
  path, content, offset: 0, line_limit: 300, size_bytes: content.length, has_more: false, ...extra,
});

function harness(readImpl = async (path) => page(path, `content of ${path}`)) {
  const timers = [];
  const reads = [];
  const states = [];
  const ctl = createPreviewController({
    read: async (path, offset) => { reads.push({ path, offset }); return readImpl(path, offset); },
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    onState: (s) => states.push(s),
  });
  return {
    ctl, timers, reads, states,
    flush: async () => { const due = timers.splice(0); await Promise.all(due.map((t) => t.fn())); await settle(); },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a selection is debounced, not read immediately", async () => {
  const h = harness();
  h.ctl.select("C:/ws", "a.txt");
  assert.equal(h.reads.length, 0, "no read before the debounce elapses");
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, PREVIEW_DEBOUNCE_MS);
  assert.equal(PREVIEW_DEBOUNCE_MS, 120);
  await h.flush();
  assert.deepEqual(h.reads, [{ path: "a.txt", offset: 0 }]);
});

test("rapid selection changes collapse to one read for the latest file", async () => {
  const h = harness();
  h.ctl.select("C:/ws", "a.txt");
  h.ctl.select("C:/ws", "b.txt");
  h.ctl.select("C:/ws", "c.txt");
  await h.flush();
  assert.deepEqual(h.reads.map((r) => r.path), ["c.txt"], "only the newest selection is read");
  assert.equal(h.ctl.current().path, "c.txt");
});

test("a cached preview is reused instead of re-reading", async () => {
  const h = harness();
  h.ctl.select("C:/ws", "a.txt");
  await h.flush();
  h.ctl.select("C:/ws", "b.txt");
  await h.flush();
  h.ctl.select("C:/ws", "a.txt");
  assert.equal(h.timers.length, 0, "a cached path emits without scheduling a read");
  assert.equal(h.reads.length, 2);
  assert.equal(h.ctl.current().data.content, "content of a.txt");
  assert.equal(h.ctl.peek("C:/ws", "a.txt").content, "content of a.txt");
});

test("the cache is scoped per workspace, so paths cannot cross workspaces", async () => {
  const h = harness(async (path) => page(path, "ws content"));
  h.ctl.select("C:/ws-a", "src/a.ts");
  await h.flush();
  assert.equal(h.ctl.peek("C:/ws-b", "src/a.ts"), null, "another workspace has no entry");
  h.ctl.select("C:/ws-b", "src/a.ts");
  assert.equal(h.timers.length, 1, "the same relative path in another workspace is a real read");
  await h.flush();
  assert.equal(h.reads.length, 2);
});

test("invalidate drops one entry and re-reads it when it is on screen", async () => {
  const h = harness();
  h.ctl.select("C:/ws", "a.txt");
  await h.flush();
  assert.equal(h.ctl.peek("C:/ws", "a.txt")?.content, "content of a.txt");
  h.ctl.invalidate("C:/ws", "a.txt");
  assert.equal(h.ctl.peek("C:/ws", "a.txt"), null, "a saved/agent-written file is never served stale");
  await h.flush();
  assert.equal(h.reads.length, 2, "the visible preview is refreshed, not left stale");
});

test("a selection pending during invalidateAll is restarted, never stranded loading", async () => {
  // Regression: opening a document tags the workspace, which invalidates every
  // preview. A preview selected in that same tick must still load instead of
  // sitting on "Loading preview…" with no read in flight.
  const h = harness();
  h.ctl.select("C:/ws", "a.txt");
  assert.equal(h.ctl.current().loading, true);
  h.ctl.invalidateAll();
  await h.flush();
  assert.deepEqual(h.reads.map((r) => r.path), ["a.txt"], "the read is reissued");
  assert.equal(h.ctl.current().loading, false);
  assert.equal(h.ctl.current().data.content, "content of a.txt");
});

test("invalidateAll clears every workspace (workspace switch)", async () => {
  const h = harness();
  h.ctl.select("C:/ws-a", "a.txt");
  await h.flush();
  h.ctl.select("C:/ws-b", "b.txt");
  await h.flush();
  h.ctl.invalidateAll();
  assert.equal(h.ctl.peek("C:/ws-a", "a.txt"), null);
  assert.equal(h.ctl.peek("C:/ws-b", "b.txt"), null);
});

test("a stale response never replaces a newer selection", async () => {
  let releaseA;
  const h = harness((path) => {
    if (path === "a.txt") return new Promise((resolve) => { releaseA = () => resolve(page("a.txt", "OLD")); });
    return Promise.resolve(page(path, "NEW"));
  });
  h.ctl.select("C:/ws", "a.txt");
  await h.flush();          // read a.txt starts and hangs
  h.ctl.select("C:/ws", "b.txt");
  await h.flush();          // b.txt resolves
  const before = h.states.length;
  releaseA();
  await settle();
  assert.equal(h.ctl.current().path, "b.txt");
  assert.equal(h.ctl.current().data.content, "NEW");
  assert.equal(h.states.length, before, "the late a.txt response emits nothing");
  assert.equal(h.ctl.peek("C:/ws", "a.txt"), null, "and it is not cached as current");
});

test("a response from the previous workspace is discarded after a switch", async () => {
  let release;
  const h = harness((path) => new Promise((resolve) => { release = () => resolve(page(path, "WS-A")); }));
  h.ctl.select("C:/ws-a", "a.txt");
  await h.flush();
  h.ctl.invalidateAll();
  h.ctl.select("C:/ws-b", "a.txt");
  release();
  await settle();
  assert.equal(h.ctl.current().workspace, "C:/ws-b");
  assert.equal(h.ctl.current().data, null, "the ws-a text never lands in the ws-b pane");
  assert.equal(h.ctl.peek("C:/ws-b", "a.txt"), null);
});

test("clearing the selection emits null without a read", async () => {
  const h = harness();
  h.ctl.select("C:/ws", "a.txt");
  h.ctl.select(null, null);
  await h.flush();
  assert.equal(h.reads.length, 0);
  assert.equal(h.ctl.current(), null);
  // Clearing is the caller's own action (FileTree drops previewPath), so the
  // controller emits no state for it — nothing else is on screen to update.
  assert.equal(h.states.filter((s) => s === null).length, 0);
});

test("a failed read surfaces as an error state and is not cached", async () => {
  const h = harness(async () => { throw new Error("binary or unreadable"); });
  h.ctl.select("C:/ws", "x.bin");
  await h.flush();
  assert.match(h.ctl.current().error, /binary or unreadable/);
  assert.equal(h.ctl.current().data, null);
  assert.equal(h.ctl.peek("C:/ws", "x.bin"), null, "a failure is retried, never remembered as content");
});

test("paging reads bypass the debounce but stay sequence-checked", async () => {
  const h = harness(async (path, offset) => page(path, `offset ${offset}`, { offset, has_more: offset === 0 }));
  const state = await h.ctl.load("C:/ws", "big.txt", 300);
  assert.deepEqual(h.reads, [{ path: "big.txt", offset: 300 }]);
  assert.equal(state.data.offset, 300);
  assert.equal(h.ctl.peek("C:/ws", "big.txt").content, "offset 300");
});

test("cancel drops a pending debounce (unmount)", async () => {
  const h = harness();
  h.ctl.select("C:/ws", "a.txt");
  h.ctl.cancel();
  await h.flush();
  assert.equal(h.reads.length, 0);
});
