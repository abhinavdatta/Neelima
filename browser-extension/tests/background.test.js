'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

function makeBackground({ respond = true, fakeTimers = false } = {}) {
  const listeners = { message: null, disconnect: null, installed: null };
  const store = {};
  const sentToNative = [];
  const port = {
    onMessage: { addListener(fn) { listeners.nativeMessage = fn; } },
    onDisconnect: { addListener(fn) { listeners.disconnect = fn; } },
    postMessage(request) {
      sentToNative.push(request);
      if (respond) setTimeout(() => listeners.nativeMessage?.({ request_id: request.request_id, status: 'connected' }), 15);
    },
    disconnect() {}
  };
  let connectionCount = 0;
  const chrome = {
    storage: { local: {
      async get(key) { return { [key]: store[key] }; },
      async set(value) { Object.assign(store, value); },
      async remove(key) { delete store[key]; }
    } },
    runtime: {
      connectNative() { connectionCount += 1; return port; },
      getManifest() { return { version: '0.3.0' }; },
      get lastError() { return null; },
      onMessage: { addListener(fn) { listeners.message = fn; } },
      onInstalled: { addListener(fn) { listeners.installed = fn; } }
    },
    permissions: { async contains() { return true; }, async getAll() { return { origins: [] }; } },
    tabs: { async query() { return [{ id: 1, url: 'https://chatgpt.com/' }]; } },
    scripting: { async executeScript() {} }
  };
  const pendingTimers = new Map();
  let nextTimer = 0;
  const schedule = fakeTimers ? (callback, delay) => { const id = ++nextTimer; pendingTimers.set(id, { callback, delay }); return id; } : setTimeout;
  const cancel = fakeTimers ? id => pendingTimers.delete(id) : clearTimeout;
  const context = vm.createContext({
    chrome, crypto: webcrypto, URL, TextEncoder, Map, Set, Promise, Date, JSON, String, Boolean, Number, Array, Error,
    setTimeout: schedule, clearTimeout: cancel, console,
    importscripts: undefined,
    importScripts() {
      const protocol = fs.readFileSync(path.join(__dirname, '..', 'protocol.js'), 'utf8');
      vm.runInContext(protocol, context);
    }
  });
  const background = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  vm.runInContext(background, context);
  function runTimers(delay) {
    for (const [id, timer] of [...pendingTimers]) if (delay === undefined || timer.delay === delay) { pendingTimers.delete(id); timer.callback(); }
  }
  return { listeners, sentToNative, store, port, runTimers, connectionCount: () => connectionCount };
}

function dispatch(listeners, message, sender) {
  return new Promise(resolve => {
    const keepAlive = listeners.message(message, sender, resolve);
    assert.equal(keepAlive, true);
  });
}

test('duplicate concurrent tool proposals are forwarded to native host once', async () => {
  const { listeners, sentToNative } = makeBackground();
  const sender = { url: 'https://chatgpt.com/', tab: { id: 1 } };
  const message = {
    type: 'NEELIMA_PROPOSE_TOOL',
    proposal: { version: 1, operation: 'tool.propose', tool: 'read_file', args: { path: 'notes.txt' } }
  };
  const [first, second] = await Promise.all([
    dispatch(listeners, message, sender),
    dispatch(listeners, message, sender)
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(sentToNative.filter(request => request.operation === 'tool.propose').length, 1);
});

test('diagnostics export payload excludes prompt and tool argument contents', async () => {
  const { listeners } = makeBackground();
  const response = await dispatch(listeners, { type: 'NEELIMA_GET_DIAGNOSTICS' }, {});
  assert.equal(response.ok, true);
  const serialized = JSON.stringify(response);
  assert.equal(serialized.includes('notes.txt'), false);
  assert.equal(serialized.includes('prompt'), false);
  assert.equal(response.diagnostics.protocolVersion, 1);
});

test('stale or mismatched native replies do not resolve another request', async () => {
  const { listeners, sentToNative, port } = makeBackground({ respond: false });
  const result = dispatch(listeners, { type: 'NEELIMA_GET_STATUS' }, {});
  while (!sentToNative.length) await new Promise(resolve => setImmediate(resolve));
  const id = sentToNative[0].request_id;
  listeners.nativeMessage({ request_id: 'old-request-id', status: 'connected' });
  listeners.nativeMessage({ request_id: id, status: 'connected' });
  const reply = await result;
  assert.equal(reply.nativeHostConnected, true);
  assert.ok(port);
});

test('native request timeout is surfaced and is never resent automatically', async () => {
  const bg = makeBackground({ respond: false, fakeTimers: true });
  const result = dispatch(bg.listeners, { type: 'NEELIMA_GET_STATUS' }, {});
  for (let i = 0; i < 10 && !bg.sentToNative.length; i++) await Promise.resolve();
  assert.equal(bg.sentToNative.length, 1);
  bg.runTimers(3500);
  const reply = await result;
  assert.equal(reply.nativeHostConnected, false);
  assert.match(reply.connectionError, /timed out/i);
  assert.equal(bg.sentToNative.length, 1);
});

test('native disconnect rejects pending work without replaying the side-effecting request', async () => {
  const bg = makeBackground({ respond: false });
  const result = dispatch(bg.listeners, { type: 'NEELIMA_GET_STATUS' }, {});
  while (!bg.sentToNative.length) await new Promise(resolve => setImmediate(resolve));
  bg.listeners.disconnect();
  const reply = await result;
  assert.equal(reply.nativeHostConnected, false);
  assert.equal(bg.sentToNative.length, 1);
});

test('a later status check reconnects after disconnect without replaying the old request', async () => {
  const bg = makeBackground({ respond: false });
  const first = dispatch(bg.listeners, { type: 'NEELIMA_GET_STATUS' }, {});
  while (!bg.sentToNative.length) await new Promise(resolve => setImmediate(resolve));
  bg.listeners.disconnect();
  await first;
  const second = dispatch(bg.listeners, { type: 'NEELIMA_GET_STATUS' }, {});
  while (bg.sentToNative.length < 2) await new Promise(resolve => setImmediate(resolve));
  bg.listeners.nativeMessage({ request_id: bg.sentToNative[1].request_id, status: 'connected' });
  const recovered = await second;
  assert.equal(recovered.nativeHostConnected, true);
  assert.equal(bg.connectionCount(), 2);
  assert.equal(bg.sentToNative.length, 2);
});

test('persistent request history reports only backend acknowledgement metadata', async () => {
  const bg = makeBackground();
  const response = await dispatch(bg.listeners, {
    type: 'NEELIMA_PROPOSE_TOOL',
    proposal: { operation: 'tool.propose', version: 1, tool: 'read_file', args: { path: 'private.txt' } }
  }, { url: 'https://chatgpt.com/', tab: { id: 1 } });
  assert.equal(response.ok, true);
  const history = await dispatch(bg.listeners, { type: 'NEELIMA_GET_REQUESTS' }, {});
  assert.equal(history.requests[0].status, 'accepted_by_backend');
  const serialized = JSON.stringify(history);
  assert.equal(serialized.includes('private.txt'), false);
  assert.equal(serialized.includes('args'), false);
});
