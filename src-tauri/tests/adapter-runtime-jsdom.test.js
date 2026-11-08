'use strict';
// jsdom regression tests for the embedded-provider reply watch (the two live
// failure modes the mock tests could not reproduce):
//   1. an SPA replaces the conversation <main> after the send — the watch must
//      still deliver the reply (previously it went deaf until the 60s watchdog);
//   2. a normal, kept container still completes.
// Real DOM, real MutationObserver, real timers — this is closer to a browser
// than the vm mocks, but still NOT a live-provider verification.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

// NEELIMA_RUNTIME lets the regression check run this suite against a specific
// copy of the runtime (used to prove the test fails on the old behaviour).
const runtimePath = process.env.NEELIMA_RUNTIME || path.join(__dirname, '../src/adapter_runtime.js');
const runtime = fs.readFileSync(runtimePath, 'utf8');
const chatgpt = require('../assets/adapter-chatgpt.json');
const claude = require('../assets/adapter-claude.json');
const gemini = require('../assets/adapter-gemini.json');
const demo = require('../assets/adapter-demo.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeWindow({ hiddenPage = false, adapter = chatgpt } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://chatgpt.com/c/test',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const posted = [];
  if (hiddenPage) {
    // Host-side hidden pane, as WebView2 reports it BEFORE the runtime loads.
    Object.defineProperty(Object.getPrototypeOf(window.document), 'visibilityState', {
      configurable: true,
      get() { return 'hidden'; },
    });
  }
  // jsdom has no execCommand: emulate the contenteditable editing path
  // (selectAll/delete/insertText) the runtime uses for ProseMirror/Slate UIs.
  window.document.execCommand = function (cmd, _show, value) {
    const el = window.document.activeElement;
    if (cmd === 'insertText' && el) {
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') el.value = String(value);
      else el.textContent = String(value);
    } else if (cmd === 'delete' && el) {
      el.textContent = '';
    }
    return true;
  };
  window.__LB_ADAPTER__ = adapter;
  window.__LB_NONCE__ = 'jsdom-nonce';
  window.__TAURI_INTERNALS__ = {
    invoke(_cmd, args) {
      posted.push(JSON.parse(args.msg));
      return Promise.resolve(null);
    },
  };
  window.eval(runtime);
  return { window, document: window.document, posted };
}

function buildChat(document) {
  const composer = document.createElement('textarea');
  composer.setAttribute('data-testid', 'prompt-textarea');
  Object.defineProperty(composer, 'getClientRects', { value: () => [{}] });
  document.body.appendChild(composer);
  composer.focus();

  const send = document.createElement('button');
  send.setAttribute('data-testid', 'send-button');
  Object.defineProperty(send, 'getClientRects', { value: () => [{}] });
  document.body.appendChild(send);

  const main = document.createElement('main');
  document.body.appendChild(main);
  return { composer, send, main };
}

function makeTurn(document, role, text) {
  const el = document.createElement('div');
  el.setAttribute('data-message-author-role', role);
  el.textContent = text;
  Object.defineProperty(el, 'getClientRects', { value: () => [{}] });
  return el;
}

function rects(el) {
  Object.defineProperty(el, 'getClientRects', { value: () => [{}] });
  return el;
}

function button(document, attrs, text = '') {
  const el = document.createElement('button');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.textContent = text;
  return rects(el);
}

/// Claude: textarea composer (the adapter's second input selector), labelled
/// send/stop controls, assistant-message nodes, and a login marker.
function buildClaudeChat(document) {
  const input = rects(document.createElement('textarea'));
  input.setAttribute('placeholder', 'Reply to Claude…');
  document.body.appendChild(input);
  const loginMarker = rects(document.createElement('div'));
  loginMarker.setAttribute('contenteditable', 'true');
  document.body.appendChild(loginMarker);
  const send = button(document, { 'aria-label': 'Send message' });
  document.body.appendChild(send);
  const main = document.createElement('main');
  document.body.appendChild(main);
  return { input, send, main };
}

function claudeTurn(document, text) {
  const el = rects(document.createElement('div'));
  el.setAttribute('data-testid', 'assistant-message');
  const body = document.createElement('div');
  body.className = 'font-claude-message';
  body.textContent = text;
  el.appendChild(body);
  return el;
}

/// Gemini: contenteditable .ql-editor composer, Send control, <model-response>
/// wrappers whose text lives in <message-content>, and no configured stop
/// selector (the adapter ships null).
function buildGeminiChat(document) {
  const input = rects(document.createElement('div'));
  input.className = 'ql-editor';
  input.setAttribute('contenteditable', 'true');
  Object.defineProperty(input, 'isContentEditable', { value: true });
  document.body.appendChild(input);
  const send = button(document, { 'aria-label': 'Send message' });
  document.body.appendChild(send);
  const main = document.createElement('main');
  document.body.appendChild(main);
  return { input, send, main };
}

function geminiResponse(document, text) {
  const wrapper = rects(document.createElement('model-response'));
  const body = document.createElement('message-content');
  body.textContent = text;
  wrapper.appendChild(body);
  return wrapper;
}

test('a replaced conversation container cannot deafen the reply watch', async () => {
  const { window, document, posted } = makeWindow();
  const { composer, send, main } = buildChat(document);

  send.addEventListener('click', () => {
    // SPA behaviour: the landing <main> is torn down and a fresh one mounts,
    // then the user turn and the assistant reply appear inside the NEW main.
    const fresh = document.createElement('main');
    document.body.appendChild(fresh);
    main.remove();
    fresh.appendChild(makeTurn(document, 'user', 'reply ready'));
    fresh.appendChild(makeTurn(document, 'assistant', 'READY'));
  });

  window.__LB__.call('send_message', JSON.stringify({ text: 'reply ready', quiet_ms: 150, timeout_ms: 5000 }), 'send1', 'jsdom-nonce');

  // The reply must be captured and pushed well inside 3 s.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await sleep(50);
    if (posted.some((m) => m.t === 'assistant_message')) break;
  }
  const pushes = posted.filter((m) => m.t === 'assistant_message');
  assert.equal(pushes.length, 1, 'exactly one completion push');
  assert.equal(pushes[0].text, 'READY');
  assert.equal(pushes[0].runtime_id.length >= 8, true);
  assert.ok(posted.some((m) => m.t === 'watch_state' && m.note === 'completed'), 'completion is diagnosed');
  await sleep(250);
  assert.equal(posted.filter((m) => m.t === 'assistant_message').length, 1, 'no duplicate push');
  window.close();
});

test('a kept conversation container still completes normally', async () => {
  const { window, document, posted } = makeWindow();
  const { composer, send, main } = buildChat(document);

  send.addEventListener('click', () => {
    main.appendChild(makeTurn(document, 'user', 'reply ready'));
    const reply = makeTurn(document, 'assistant', 'READY');
    main.appendChild(reply);
  });

  window.__LB__.call('send_message', JSON.stringify({ text: 'reply ready', quiet_ms: 150, timeout_ms: 5000 }), 'send2', 'jsdom-nonce');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await sleep(50);
    if (posted.some((m) => m.t === 'assistant_message')) break;
  }
  const pushes = posted.filter((m) => m.t === 'assistant_message');
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].text, 'READY');
  window.close();
});

test('submission confirms on composer-cleared + assistant-count signals without exact text equality', async () => {
  const { window, document, posted } = makeWindow();
  const { composer, send, main } = buildChat(document);
  const longText = 'x'.repeat(400) + ' unique-tail-marker ' + 'y'.repeat(300);

  send.addEventListener('click', () => {
    // The provider collapses/normalizes long turns: the rendered user turn
    // does NOT equal the sent text, the composer is cleared, and an assistant
    // turn appears.
    composer.value = '';
    main.appendChild(makeTurn(document, 'user', longText.slice(0, 120) + ' … ' + longText.slice(-120)));
    main.appendChild(makeTurn(document, 'assistant', 'working'));
  });

  window.__LB__.call('send_message', JSON.stringify({ text: longText, quiet_ms: 150, timeout_ms: 5000 }), 'send3', 'jsdom-nonce');
  await sleep(600);
  const result = posted.find((m) => m.t === 'rpc_result' && m.id === 'send3');
  assert.ok(result, 'send_message resolved');
  const value = JSON.parse(result.v);
  assert.equal(value.ok, true);
  assert.equal(value.value.sent, true, 'submission confirmed via alternative signals');
  assert.equal(value.value.submission_confirmed, true);
  window.close();
});

// Live regression (cold start): a freshly mounted provider webview can commit
// the real document right after the composer was filled, destroying the send
// button that was already resolved. The click used to land on that detached
// node, the submission silently vanished, and the task hung to its deadline.
// The guard must re-resolve the button on the settled document and click ONCE.
test('a send button detached by a late document commit is re-resolved and clicked once', async () => {
  const { window, document, posted } = makeWindow();
  const { composer, send, main } = buildChat(document);
  let clicks = 0;

  function submit() {
    clicks += 1;
    composer.value = '';
    main.appendChild(makeTurn(document, 'user', 'cold start prompt'));
    main.appendChild(makeTurn(document, 'assistant', 'COLD START REPLY'));
  }

  // The composer receives the prompt first; the reload then swaps the button.
  composer.addEventListener('input', () => {
    setTimeout(() => {
      const fresh = document.createElement('button');
      fresh.setAttribute('data-testid', 'send-button');
      Object.defineProperty(fresh, 'getClientRects', { value: () => [{}] });
      fresh.addEventListener('click', submit);
      send.replaceWith(fresh);
    }, 0);
  });
  send.addEventListener('click', submit);

  window.__LB__.call('send_message', JSON.stringify({ text: 'cold start prompt', quiet_ms: 150, timeout_ms: 5000 }), 'send-cold', 'jsdom-nonce');

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await sleep(50);
    if (posted.some((m) => m.t === 'rpc_result' && m.id === 'send-cold')) break;
  }
  const result = posted.find((m) => m.t === 'rpc_result' && m.id === 'send-cold');
  assert.ok(result, 'send_message resolved');
  const value = JSON.parse(result.v).value;
  assert.equal(value.sent, true, 'the prompt is reported as sent');
  assert.equal(value.submission_confirmed, true, 'the submission is confirmed on the fresh button');
  assert.equal(clicks, 1, 'exactly one click — a stale node must never double-submit');
  window.close();
});

// Live regression: Neelima reuses one provider chat per conversation, so a
// follow-up prompt is sent into a conversation that ALREADY shows an
// assistant turn. At the first quiet tick there is no NEW assistant turn yet
// (the model is still thinking) — the watch must keep waiting, not declare the
// turn finished. Previously it aborted at that tick and the reply, which
// arrived later, was never pushed (UI: "response timeout").
test('a follow-up turn in an existing conversation still captures the new reply', async () => {
  const { window, document, posted } = makeWindow();
  const { composer, send, main } = buildChat(document);

  // Pre-existing history from an earlier prompt in the same provider chat.
  main.appendChild(makeTurn(document, 'user', 'first prompt'));
  main.appendChild(makeTurn(document, 'assistant', 'OLD REPLY'));

  send.addEventListener('click', () => {
    composer.value = '';
    main.appendChild(makeTurn(document, 'user', 'second prompt'));
    // The provider shows its streaming Stop control immediately — this is the
    // "generation started" signal — but no assistant turn exists yet.
    const stop = document.createElement('button');
    stop.setAttribute('data-testid', 'stop-button');
    Object.defineProperty(stop, 'getClientRects', { value: () => [{}] });
    document.body.appendChild(stop);
    // Streaming ends BEFORE the assistant turn is mounted: one quiet window
    // passes with the old reply still in the DOM. That intermediate tick must
    // not end the watch.
    setTimeout(() => stop.remove(), 250);
    setTimeout(() => {
      main.appendChild(makeTurn(document, 'assistant', 'NEW REPLY'));
    }, 500);
  });

  window.__LB__.call('send_message', JSON.stringify({ text: 'second prompt', quiet_ms: 150, timeout_ms: 5000 }), 'send4', 'jsdom-nonce');

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await sleep(50);
    if (posted.some((m) => m.t === 'assistant_message')) break;
  }
  const pushes = posted.filter((m) => m.t === 'assistant_message');
  assert.equal(pushes.length, 1, 'exactly one completion push');
  assert.equal(pushes[0].text, 'NEW REPLY', 'pushes the new reply, never the old turn');
  window.close();
});

// ---------------------------------------------------------------------------
// Provider adapters: Claude, Gemini and the bundled demo page.
// Synthetic, deterministic DOMs shaped like each adapter's selectors. These
// are adapter-contract tests, NOT live website verification.
// ---------------------------------------------------------------------------

test('Claude capture completes and echoes the send correlation ID', async () => {
  const { window, document, posted } = makeWindow({ adapter: claude });
  const { send, main } = buildClaudeChat(document);
  main.appendChild(claudeTurn(document, 'OLD ANSWER'));

  send.addEventListener('click', () => {
    const user = rects(document.createElement('div'));
    user.setAttribute('data-message-author-role', 'user');
    user.textContent = 'reply with READY';
    main.appendChild(user);
    const stop = button(document, { 'aria-label': 'Stop response' });
    document.body.appendChild(stop);
    setTimeout(() => stop.remove(), 250);
    setTimeout(() => main.appendChild(claudeTurn(document, 'READY')), 300);
  });

  window.__LB__.call('send_message', JSON.stringify({ text: 'reply with READY', quiet_ms: 150, timeout_ms: 5000, request_id: 'task-claude.12345678' }), 'send-claude', 'jsdom-nonce');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await sleep(50);
    if (posted.some((m) => m.t === 'assistant_message')) break;
  }
  const pushes = posted.filter((m) => m.t === 'assistant_message');
  assert.equal(pushes.length, 1, 'Claude completes exactly once');
  assert.equal(pushes[0].text, 'READY');
  assert.equal(pushes[0].request_id, 'task-claude.12345678');
  window.close();
});

test('Gemini reuses one response container and still captures the new answer', async () => {
  const { window, document, posted } = makeWindow({ adapter: gemini });
  const { input, send, main } = buildGeminiChat(document);
  const response = geminiResponse(document, 'OLD ANSWER');
  main.appendChild(response);

  send.addEventListener('click', () => {
    input.textContent = '';
    const user = rects(document.createElement('div'));
    user.setAttribute('data-message-author-role', 'user');
    user.textContent = 'reply with NEW';
    main.appendChild(user);
    // The SPA streams into the SAME <model-response> node: the assistant
    // count never grows, only the text changes.
    setTimeout(() => { response.querySelector('message-content').textContent = 'NEW ANSWER'; }, 250);
  });

  window.__LB__.call('send_message', JSON.stringify({ text: 'reply with NEW', quiet_ms: 150, timeout_ms: 5000, request_id: 'task-gemini.aaaaaaaa' }), 'send-gemini', 'jsdom-nonce');
  const deadline = Date.now() + 3500;
  while (Date.now() < deadline) {
    await sleep(50);
    if (posted.some((m) => m.t === 'assistant_message')) break;
  }
  const pushes = posted.filter((m) => m.t === 'assistant_message');
  assert.equal(pushes.length, 1, 'exactly one push');
  assert.equal(pushes[0].text, 'NEW ANSWER', 'never the previous turn');
  assert.equal(pushes[0].request_id, 'task-gemini.aaaaaaaa');
  window.close();
});

test('a stop-less provider needs a second quiet window, so a stream pause is not a completion', async () => {
  const { window, document, posted } = makeWindow({ adapter: gemini });
  const { input, send, main } = buildGeminiChat(document);
  const response = geminiResponse(document, '');
  main.appendChild(response);

  send.addEventListener('click', () => {
    input.textContent = '';
    const user = rects(document.createElement('div'));
    user.setAttribute('data-message-author-role', 'user');
    user.textContent = 'stream slowly';
    main.appendChild(user);
    const body = response.querySelector('message-content');
    body.textContent = 'PART ONE';
    setTimeout(() => { body.textContent = 'PART ONE PART TWO'; }, 230);
  });

  window.__LB__.call('send_message', JSON.stringify({ text: 'stream slowly', quiet_ms: 150, timeout_ms: 5000, request_id: 'task-gemini.bbbbbbbb' }), 'send-gemini-2', 'jsdom-nonce');
  const deadline = Date.now() + 3500;
  while (Date.now() < deadline) {
    await sleep(50);
    if (posted.some((m) => m.t === 'assistant_message')) break;
  }
  await sleep(200);
  const pushes = posted.filter((m) => m.t === 'assistant_message');
  assert.equal(pushes.length, 1, 'exactly one completion push');
  assert.equal(pushes[0].text, 'PART ONE PART TWO', 'the pause was not reported as a finished reply');
  window.close();
});

test('the demo adapter never pushes the user turn as the assistant reply', async () => {
  const { window, document, posted } = makeWindow({ adapter: demo });
  const messages = document.createElement('div');
  messages.id = 'messages';
  document.body.appendChild(messages);
  const input = rects(document.createElement('textarea'));
  input.id = 'ta';
  input.setAttribute('data-testid', 'chat-input');
  document.body.appendChild(input);
  const send = button(document, { id: 'send' });
  document.body.appendChild(send);

  send.addEventListener('click', () => {
    const stop = button(document, { id: 'stop' });
    document.body.appendChild(stop);
    const user = document.createElement('div');
    user.className = 'msg user';
    user.textContent = 'hello demo';
    messages.appendChild(user);
    setTimeout(() => {
      stop.remove();
      const reply = document.createElement('div');
      reply.className = 'msg';
      reply.textContent = 'DONE: demo reply';
      messages.appendChild(reply);
    }, 200);
  });

  window.__LB__.call('send_message', JSON.stringify({ text: 'hello demo', quiet_ms: 100, timeout_ms: 5000, request_id: 'task-demo.cccccccc' }), 'send-demo', 'jsdom-nonce');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await sleep(50);
    if (posted.some((m) => m.t === 'assistant_message')) break;
  }
  const pushes = posted.filter((m) => m.t === 'assistant_message');
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].text, 'DONE: demo reply');
  assert.ok(!pushes[0].text.includes('hello demo'), 'the prompt is never returned as the reply');
  window.close();
});

async function pageLogin(window, document, posted, id) {
  window.__LB__.call('page_info', null, id, 'jsdom-nonce');
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    await sleep(20);
    const result = posted.find((m) => m.t === 'rpc_result' && m.id === id);
    if (result) return JSON.parse(result.v).value.login;
  }
  throw new Error('page_info did not resolve');
}

test('Claude and Gemini do not call a bare composer an authenticated session', async () => {
  for (const [adapter, build, marker] of [
    [claude, buildClaudeChat, 'profile-menu-button'],
    [gemini, buildGeminiChat, 'account-menu-button'],
  ]) {
    const { window, document, posted } = makeWindow({ adapter });
    build(document);
    // evalLogin deliberately reports "loading" until the document is complete.
    for (let i = 0; i < 100 && document.readyState !== 'complete'; i++) await sleep(10);
    const before = await pageLogin(window, document, posted, 'login-before');
    assert.equal(before.state, 'unknown', `${adapter.id}: composer alone is not proof`);

    const profile = button(document, { 'data-testid': marker });
    document.body.appendChild(profile);
    // A DOM change re-evaluates login; page_info reads it fresh anyway.
    const after = await pageLogin(window, document, posted, 'login-after');
    assert.equal(after.state, 'logged_in', `${adapter.id}: account marker confirms sign-in`);
    window.close();
  }
});

test('Claude and Gemini report an actionable page_changed when the composer is missing', async () => {
  for (const adapter of [claude, gemini]) {
    const { window, document, posted } = makeWindow({ adapter });
    window.__LB__.call('send_message', JSON.stringify({ text: 'hello' }), 'send-missing', 'jsdom-nonce');
    await sleep(300);
    const result = posted.find((m) => m.t === 'rpc_result' && m.id === 'send-missing');
    assert.ok(result, `${adapter.id}: send resolves`);
    const value = JSON.parse(result.v).value;
    assert.equal(value.error_type, 'page_changed', `${adapter.id}: missing composer is a page change`);
    assert.notEqual(value.sent, true, `${adapter.id}: never claims the prompt was sent`);
    window.close();
  }
});

test('Claude still captures the reply when assistant selectors go stale (sibling anchor)', async () => {
  const { window, document, posted } = makeWindow({ adapter: claude });
  const { input, send, main } = buildClaudeChat(document);
  // Pre-existing turn, found only through the user-role fallback.
  const oldUser = rects(document.createElement('div'));
  oldUser.setAttribute('data-message-author-role', 'user');
  oldUser.textContent = 'old prompt';
  main.appendChild(oldUser);
  const oldReply = document.createElement('div');
  oldReply.textContent = 'OLD ANSWER';
  main.appendChild(oldReply);

  send.addEventListener('click', () => {
    input.value = '';
    const user = rects(document.createElement('div'));
    user.setAttribute('data-message-author-role', 'user');
    user.textContent = 'reply with READY';
    main.appendChild(user);
    // Provider rename: the new reply has NO assistant-message test id and no
    // known class — only its position after the confirmed user turn remains.
    const reply = document.createElement('div');
    reply.textContent = 'READY';
    setTimeout(() => main.appendChild(reply), 120);
  });

  window.__LB__.call('send_message', JSON.stringify({ text: 'reply with READY', quiet_ms: 120, timeout_ms: 4000, request_id: 'task-claude.stale000' }), 'send-claude-stale', 'jsdom-nonce');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await sleep(50);
    if (posted.some((m) => m.t === 'assistant_message')) break;
  }
  const pushes = posted.filter((m) => m.t === 'assistant_message');
  assert.equal(pushes.length, 1, 'exactly one push after selector drift');
  assert.equal(pushes[0].text, 'READY');
  assert.equal(pushes[0].request_id, 'task-claude.stale000');
  window.close();
});

test('cancelling a request tears down the watch and drops a later reply', async () => {
  const { window, document, posted } = makeWindow({ adapter: claude });
  const { input, send, main } = buildClaudeChat(document);
  send.addEventListener('click', () => {
    input.value = '';
    const user = rects(document.createElement('div'));
    user.setAttribute('data-message-author-role', 'user');
    user.textContent = 'reply later';
    main.appendChild(user);
    setTimeout(() => main.appendChild(claudeTurn(document, 'TOO LATE')), 300);
  });
  window.__LB__.call('send_message', JSON.stringify({ text: 'reply later', quiet_ms: 120, timeout_ms: 4000, request_id: 'task-claude.cancel000' }), 'send-claude-cancel', 'jsdom-nonce');
  await sleep(80);
  const cancelled = window.__LB__.call('cancel_response', null, 'cancel-claude', 'jsdom-nonce');
  assert.equal(cancelled, undefined, 'cancel is dispatched');
  await sleep(800);
  assert.equal(posted.filter((m) => m.t === 'assistant_message').length, 0, 'no push after cancellation');
  window.close();
});

test('Claude generation that ends without a reply reports a provider error', async () => {
  const { window, document, posted } = makeWindow({ adapter: claude });
  const { input, send, main } = buildClaudeChat(document);
  send.addEventListener('click', () => {
    input.value = '';
    const user = rects(document.createElement('div'));
    user.setAttribute('data-message-author-role', 'user');
    user.textContent = 'trigger an error';
    main.appendChild(user);
    const stop = button(document, { 'aria-label': 'Stop response' });
    document.body.appendChild(stop);
    setTimeout(() => stop.remove(), 120);
  });
  window.__LB__.call('send_message', JSON.stringify({ text: 'trigger an error', quiet_ms: 120, timeout_ms: 4000, request_id: 'task-claude.err000' }), 'send-claude-error', 'jsdom-nonce');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await sleep(50);
    if (posted.some((m) => m.t === 'response_error')) break;
  }
  const errors = posted.filter((m) => m.t === 'response_error');
  assert.equal(errors.length, 1, 'one honest error report');
  assert.equal(errors[0].code, 'provider_error');
  assert.equal(errors[0].request_id, 'task-claude.err000');
  assert.equal(posted.filter((m) => m.t === 'assistant_message').length, 0, 'no fabricated reply');
  window.close();
});

test('the injected runtime reports the page as visible even when the host hides the pane', async () => {
  const { window, document, posted } = makeWindow({ hiddenPage: true });
  const { send } = buildChat(document);
  window.__LB__.call('page_info', null, 'info1', 'jsdom-nonce');
  await sleep(50);
  const result = posted.find((m) => m.t === 'rpc_result' && m.id === 'info1');
  const info = JSON.parse(result.v).value;
  assert.equal(info.visibility_state, 'visible', 'visibility override keeps the page "visible"');
  assert.equal(info.watch.attached_target, null, 'no watch armed yet');
  window.close();
});

// ---- reply detection across provider layouts (2026 markup drift) -----------
// Live evidence documents several chatgpt.com transcript layouts in rotation:
// role attributes, list transcripts with `data-message-role`, and per-turn
// wrappers whose <article> became a <section>. The reply is VISIBLE on the page
// in all of them; a single-selector detector silently finds zero nodes and
// Neelima then reports "no reply" while the user is looking at the answer.

/// List-transcript layout: each turn is <li data-message-role>, the prompt is
/// wrapped in <button data-user-message-bubble>, the answer body lives in
/// [data-message-content].
function buildListTranscript(document, { answer, prompt }) {
  const main = document.createElement('main');
  document.body.appendChild(main);
  const list = document.createElement('ol');
  list.setAttribute('data-conversation-transcript', '');
  main.appendChild(list);
  const promptTurn = document.createElement('li');
  promptTurn.setAttribute('data-message-role', 'user');
  const bubble = document.createElement('button');
  bubble.setAttribute('data-user-message-bubble', '');
  bubble.textContent = prompt;
  promptTurn.appendChild(bubble);
  list.appendChild(promptTurn);
  const answerTurn = document.createElement('li');
  answerTurn.setAttribute('data-message-role', 'assistant');
  const body = document.createElement('div');
  body.setAttribute('data-message-content', '');
  body.textContent = answer;
  answerTurn.appendChild(body);
  list.appendChild(answerTurn);
  return { main, list };
}

async function rpc(predicate, id) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    await sleep(20);
    const hit = predicate();
    if (hit) return hit;
  }
  return null;
}

test('a list-transcript reply is detected instead of reported as missing', async () => {
  const { window, document, posted } = makeWindow();
  const { composer, send } = buildChat(document);
  send.addEventListener('click', () => {
    composer.value = '';
    buildListTranscript(document, { answer: 'READY', prompt: 'reply ready' });
  });
  window.__LB__.call(
    'send_message',
    JSON.stringify({ text: 'reply ready', quiet_ms: 120, timeout_ms: 4000, request_id: 'task-list.aaaaaaaa' }),
    'send-list',
    'jsdom-nonce'
  );
  const push = await rpc(() => posted.find((m) => m.t === 'assistant_message'));
  assert.ok(push, 'the reply is pushed, not silently dropped');
  assert.equal(push.text, 'READY');
  assert.ok(!push.text.includes('reply ready'), 'the prompt is never pushed as the answer');
  window.close();
});

test('a per-turn <section> wrapper without a role attribute is still read', async () => {
  const { window, document, posted } = makeWindow();
  buildChat(document);
  const main = document.querySelector('main');
  // Wrapper layout: the role is only in the wrapper's testid/labels.
  const turn = document.createElement('section');
  turn.setAttribute('data-testid', 'conversation-turn-2');
  turn.textContent = 'ChatGPT said: 42';
  main.appendChild(turn);

  window.__LB__.call('capture_reply', null, 'cap-wrapper', 'jsdom-nonce');
  const res = await rpc(() => posted.find((m) => m.t === 'rpc_result' && m.id === 'cap-wrapper'));
  assert.ok(res, 'capture_reply answers');
  const value = JSON.parse(res.v).value;
  assert.equal(value.has_reply, true, 'a reply is recognised on the wrapper layout');
  assert.match(value.text, /42/);
  assert.equal(value.layout, 'turns', 'the detection family is reported for diagnostics');
  window.close();
});

test('a user-only page never reports the prompt as an assistant reply', async () => {
  const { window, document, posted } = makeWindow();
  buildChat(document);
  const main = document.querySelector('main');
  const turn = document.createElement('section');
  turn.setAttribute('data-testid', 'conversation-turn-1');
  turn.setAttribute('data-turn', 'user');
  turn.textContent = 'do not answer with this';
  main.appendChild(turn);

  window.__LB__.call('capture_reply', null, 'cap-useronly', 'jsdom-nonce');
  const res = await rpc(() => posted.find((m) => m.t === 'rpc_result' && m.id === 'cap-useronly'));
  const value = JSON.parse(res.v).value;
  assert.equal(value.has_reply, false, 'a prompt is not an answer');
  assert.equal(value.text, '');
  window.close();
});

// ChatGPT's October DIL page structure from snapshot3k.json: user identity is
// not present in the saved snapshot, so fixtures keep the already supported
// user selector; assistant identity and content nesting mirror observed markup.
function chatgptAssistantTurn(document, suffix, text) {
  const turn = document.createElement('div');
  turn.setAttribute('data-content-search-unit-key', `fixture:turn:${suffix}:assistant`);
  turn.setAttribute('data-chatgpt-search-unit-key', `fixture:turn:${suffix}:assistant`);
  const group = document.createElement('div');
  const body = document.createElement('div');
  body.setAttribute('data-markdown-text-style', 'assistant-message');
  body.textContent = text;
  group.appendChild(body);
  turn.appendChild(group);
  return turn;
}

test('ChatGPT DIL turn keys count distinct assistant turns and extract only the nested assistant body', async () => {
  const { window, document, posted } = makeWindow();
  buildChat(document);
  const main = document.querySelector('main');
  const user1 = makeTurn(document, 'user', 'first prompt');
  const user2 = makeTurn(document, 'user', 'second prompt');
  const firstAssistant = chatgptAssistantTurn(document, '1', 'first answer');
  const secondAssistant = chatgptAssistantTurn(document, '2', 'second answer');
  secondAssistant.removeAttribute('data-content-search-unit-key');
  main.append(user1, firstAssistant, user2, secondAssistant);

  window.__LB__.call('page_info', null, 'info-dil-count', 'jsdom-nonce');
  const info = await rpc(() => posted.find((m) => m.t === 'rpc_result' && m.id === 'info-dil-count'));
  const page = JSON.parse(info.v).value;
  assert.equal(page.turns.users, 2, 'distinct user turns remain detected');
  assert.equal(page.turns.assistants, 2, 'turn-level keys identify two assistant turns');

  window.__LB__.call('capture_reply', null, 'cap-dil-turn', 'jsdom-nonce');
  const captured = await rpc(() => posted.find((m) => m.t === 'rpc_result' && m.id === 'cap-dil-turn'));
  const reply = JSON.parse(captured.v).value;
  assert.equal(reply.assistant_count, 2);
  assert.equal(reply.text, 'second answer');
  assert.equal(reply.has_reply, true);
  assert.equal(reply.layout, 'adapter');
  window.close();
});

test('nested assistant search-unit markers still count as one turn', async () => {
  const { window, document, posted } = makeWindow();
  buildChat(document);
  const outer = document.createElement('div');
  outer.setAttribute('data-content-search-unit-key', 'fixture:turn:nested-key:assistant');
  const inner = document.createElement('div');
  inner.setAttribute('data-chatgpt-search-unit-key', 'fixture:turn:nested-key:assistant');
  const body = document.createElement('div');
  body.setAttribute('data-markdown-text-style', 'assistant-message');
  body.textContent = 'one distinct turn';
  inner.appendChild(body);
  outer.appendChild(inner);
  document.querySelector('main').appendChild(outer);

  window.__LB__.call('page_info', null, 'info-dil-nested-key', 'jsdom-nonce');
  const result = await rpc(() => posted.find((m) => m.t === 'rpc_result' && m.id === 'info-dil-nested-key'));
  assert.equal(JSON.parse(result.v).value.turns.assistants, 1);
  window.close();
});

test('the alternate ChatGPT search-unit attribute alone identifies a DIL assistant turn', async () => {
  const { window, document, posted } = makeWindow();
  buildChat(document);
  const turn = document.createElement('div');
  turn.setAttribute('data-chatgpt-search-unit-key', 'fixture:turn:alternate:assistant');
  const body = document.createElement('div');
  body.setAttribute('data-markdown-text-style', 'assistant-message');
  body.textContent = 'alternate-key answer';
  turn.appendChild(body);
  document.querySelector('main').appendChild(turn);

  window.__LB__.call('capture_reply', null, 'cap-dil-alternate-key', 'jsdom-nonce');
  const result = await rpc(() => posted.find((m) => m.t === 'rpc_result' && m.id === 'cap-dil-alternate-key'));
  const value = JSON.parse(result.v).value;
  assert.equal(value.assistant_count, 1);
  assert.equal(value.text, 'alternate-key answer');
  assert.equal(value.has_reply, true);
  window.close();
});

test('nested ChatGPT markdown identity never inflates the turn count', async () => {
  const { window, document, posted } = makeWindow();
  buildChat(document);
  const main = document.querySelector('main');
  main.appendChild(chatgptAssistantTurn(document, 'nested', 'one answer'));
  window.__LB__.call('page_info', null, 'info-dil-nested', 'jsdom-nonce');
  const res = await rpc(() => posted.find((m) => m.t === 'rpc_result' && m.id === 'info-dil-nested'));
  const info = JSON.parse(res.v).value;
  assert.equal(info.turns.assistants, 1);
  assert.equal(info.messages_found, true);
  window.close();
});

test('ChatGPT user turns without an identified assistant response and landing-page copy stay empty', async () => {
  const { window, document, posted } = makeWindow();
  buildChat(document);
  const main = document.querySelector('main');
  main.innerHTML = '<nav>Navigation</nav><div class="markdown">Welcome to ChatGPT</div><div class="prose">Suggested prompt</div><section data-testid="conversation-turn-suggestion">Try asking a question</section>';
  window.__LB__.call('capture_reply', null, 'cap-dil-landing', 'jsdom-nonce');
  const landing = await rpc(() => posted.find((m) => m.t === 'rpc_result' && m.id === 'cap-dil-landing'));
  const landingValue = JSON.parse(landing.v).value;
  assert.equal(landingValue.has_reply, false);
  assert.equal(landingValue.assistant_count, 0);
  assert.equal(landingValue.text, '');
  assert.equal(landingValue.layout, 'none', 'navigation, hero and unlabeled turn-like suggestions are not assistant turns');

  main.replaceChildren(makeTurn(document, 'user', 'pending question'));
  window.__LB__.call('capture_reply', null, 'cap-dil-no-answer', 'jsdom-nonce');
  const unanswered = await rpc(() => posted.find((m) => m.t === 'rpc_result' && m.id === 'cap-dil-no-answer'));
  const unansweredValue = JSON.parse(unanswered.v).value;
  assert.equal(unansweredValue.user_count, 1);
  assert.equal(unansweredValue.assistant_count, 0);
  assert.equal(unansweredValue.has_reply, false);
  assert.equal(unansweredValue.text, '');
  window.close();
});

test('malformed and ambiguous ChatGPT turn identities do not count as assistant replies', async () => {
  const { window, document, posted } = makeWindow();
  buildChat(document);
  const main = document.querySelector('main');
  for (const key of ['assistant', 'turn:assistant:extra', 'turn:user']) {
    const node = document.createElement('div');
    node.setAttribute('data-content-search-unit-key', key);
    node.setAttribute('data-markdown-text-style', 'assistant-message');
    node.textContent = 'not a confirmed response';
    main.appendChild(node);
  }
  window.__LB__.call('capture_reply', null, 'cap-dil-malformed', 'jsdom-nonce');
  const res = await rpc(() => posted.find((m) => m.t === 'rpc_result' && m.id === 'cap-dil-malformed'));
  const value = JSON.parse(res.v).value;
  assert.equal(value.assistant_count, 0);
  assert.equal(value.has_reply, false);
  assert.equal(value.text, '');
  window.close();
});

test('page_info reports which reply layout matched', async () => {
  const { window, document, posted } = makeWindow();
  buildChat(document);
  buildListTranscript(document, { answer: 'hi there', prompt: 'hello' });
  window.__LB__.call('page_info', null, 'info-layout', 'jsdom-nonce');
  const res = await rpc(() => posted.find((m) => m.t === 'rpc_result' && m.id === 'info-layout'));
  const info = JSON.parse(res.v).value;
  assert.equal(info.turns.assistants, 1, 'the assistant turn is counted');
  assert.equal(info.turns.users, 1, 'the prompt is counted as a user turn');
  assert.ok(['role', 'adapter', 'turns'].includes(info.reply_layout), `layout reported (${info.reply_layout})`);
  assert.notEqual(info.reply_layout, 'none');
  window.close();
});

// ---- attribute-free layout (generic provider fallback) ---------------------
// Content-only fallback remains available to non-ChatGPT adapters. ChatGPT
// fails closed unless the saved assistant-turn identity is present.

function buildAttributeFreeChat(document, { prompt, answer }) {
  const main = document.createElement('main');
  document.body.appendChild(main);
  // The prompt: a plain bubble, right aligned, no helpful attributes at all.
  const promptWrap = document.createElement('div');
  promptWrap.className = 'flex justify-end';
  const bubble = document.createElement('div');
  bubble.className = 'rounded bg-token-surface';
  bubble.textContent = prompt;
  promptWrap.appendChild(bubble);
  main.appendChild(promptWrap);
  return { main, addAnswer(text) {
    const turn = document.createElement('div');
    turn.className = 'flex flex-col';
    const body = document.createElement('div');
    body.className = 'markdown prose';
    body.textContent = text;
    turn.appendChild(body);
    main.appendChild(turn);
    return turn;
  } };
}

test('an attribute-free page still yields the reply (content blocks, no selectors)', async () => {
  const { window, document, posted } = makeWindow({ adapter: { ...chatgpt, id: 'generic' } });
  buildChat(document);
  const page = buildAttributeFreeChat(document, { prompt: 'hello are you working?', answer: '' });

  window.__LB__.call('capture_reply', null, 'cap-nada', 'jsdom-nonce');
  await sleep(60);
  let res = posted.find((m) => m.t === 'rpc_result' && m.id === 'cap-nada');
  assert.equal(JSON.parse(res.v).value.has_reply, false, 'nothing to capture before the answer');

  page.addAnswer("I'm working!");
  window.__LB__.call('capture_reply', null, 'cap-nada2', 'jsdom-nonce');
  res = await rpc(() => posted.find((m) => m.t === 'rpc_result' && m.id === 'cap-nada2'));
  const value = JSON.parse(res.v).value;
  assert.equal(value.has_reply, true, 'the visible answer is found without any message attributes');
  assert.equal(value.text, "I'm working!");
  assert.equal(value.layout, 'content', 'the fallback family is reported');
  assert.ok(Array.isArray(value.dom.blocks) && value.dom.blocks.length >= 1, 'structure is reported');
  assert.ok(value.dom.blocks.some((b) => b.text_len > 0), 'text length is reported, never text');
  window.close();
});

test('a prompt that renders markdown is never returned as the answer', async () => {
  const { window, document, posted } = makeWindow({ adapter: { ...chatgpt, id: 'generic' } });
  const { composer, send } = buildChat(document);
  const main = document.createElement('main');
  document.body.appendChild(main);
  const prompt = 'tool ```json {"tool":"read_file"}```';
  // The provider renders the PROMPT through the same markdown pipeline.
  send.addEventListener('click', () => {
    composer.value = '';
    const promptBody = document.createElement('div');
    promptBody.className = 'markdown prose';
    promptBody.textContent = prompt;
    main.appendChild(promptBody);
  });
  window.__LB__.call(
    'send_message',
    JSON.stringify({ text: prompt, quiet_ms: 150, timeout_ms: 3000, request_id: 'task-md.bbbbbbbb' }),
    'send-md',
    'jsdom-nonce'
  );
  await sleep(150);
  window.__LB__.call('capture_reply', null, 'cap-md', 'jsdom-nonce');
  const res = await rpc(() => posted.find((m) => m.t === 'rpc_result' && m.id === 'cap-md'));
  const value = JSON.parse(res.v).value;
  assert.equal(value.has_reply, false, 'the sent prompt is not an answer');
  assert.equal(value.text, '');
  assert.equal(posted.filter((m) => m.t === 'assistant_message').length, 0, 'nothing is pushed');

  const answer = document.createElement('div');
  answer.className = 'markdown prose';
  answer.textContent = 'DONE';
  main.appendChild(answer);
  window.__LB__.call('capture_reply', null, 'cap-md2', 'jsdom-nonce');
  const after = await rpc(() => posted.find((m) => m.t === 'rpc_result' && m.id === 'cap-md2'));
  assert.equal(JSON.parse(after.v).value.text, 'DONE', 'the genuine answer is still found');
  window.close();
});

test('a rendered code block keeps its ``` fence in the pushed reply (tool protocol survives markdown capture)', async () => {
  const { window, document, posted } = makeWindow();
  const { composer, send } = buildChat(document);
  const main = document.createElement('main');
  document.body.appendChild(main);
  const toolJson = '{"id":"1","tool":"write_file","k":"jsdom-nonce","args":{"path":"note.md","content":"hi"}}';
  send.addEventListener('click', () => {
    composer.value = '';
    const user = makeTurn(document, 'user', 'create note.md please');
    main.appendChild(user);
    setTimeout(() => {
      // ChatGPT-style rendering: prose paragraph plus a code block whose
      // literal fences are NOT text nodes (header row shows the info string).
      const answer = document.createElement('div');
      answer.setAttribute('data-message-author-role', 'assistant');
      const prose = document.createElement('p');
      prose.textContent = 'On it.';
      answer.appendChild(prose);
      const block = document.createElement('div');
      const header = document.createElement('span');
      header.textContent = 'tool';
      block.appendChild(header);
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.className = 'language-tool';
      code.textContent = toolJson;
      pre.appendChild(code);
      block.appendChild(pre);
      answer.appendChild(block);
      main.appendChild(answer);
    }, 200);
  });
  window.__LB__.call(
    'send_message',
    JSON.stringify({ text: 'create note.md please', quiet_ms: 150, timeout_ms: 4000, request_id: 'task-fence.aaaaaaaa' }),
    'send-fence',
    'jsdom-nonce'
  );
  const deadline = Date.now() + 3500;
  while (Date.now() < deadline) {
    await sleep(50);
    if (posted.some((m) => m.t === 'assistant_message')) break;
  }
  await sleep(200);
  const pushes = posted.filter((m) => m.t === 'assistant_message');
  assert.equal(pushes.length, 1, 'exactly one completion push');
  assert.ok(
    pushes[0].text.includes('```tool\n' + toolJson + '\n```'),
    'the captured reply carries the literal fenced tool block; got: ' + JSON.stringify(pushes[0].text)
  );
  window.close();
});

test('a flattened DIL reply (no <pre> anywhere) still yields a fenced ```tool block', async () => {
  const { window, document, posted } = makeWindow({ adapter: { ...chatgpt, selectors: { ...chatgpt.selectors, messages: '[data-dil-assistant-turn]' } } });
  const { composer, send } = buildChat(document);
  const main = document.createElement('main');
  document.body.appendChild(main);
  // Live chatgpt.com structure (2026-10 DIL renderer), metadata-accurate:
  // MarkdownRoot > group > prose container > PortalBoundary/Renderer >
  // DilRenderer > ONE <p data-d-component=text> holding the ENTIRE reply as
  // text with tiny inline <code data-d-component=code> spans. No <pre>, no
  // fence characters anywhere in the DOM.
  const toolJson = '{"id":"1","tool":"write_file","k":"jsdom-nonce","args":{"path":"note.md","content":"hi"}}';
  send.addEventListener('click', () => {
    composer.value = '';
    const user = makeTurn(document, 'user', 'create note.md please');
    main.appendChild(user);
    setTimeout(() => {
      const root = document.createElement('div');
      root.setAttribute('data-content-search-unit-key', 'fixture:turn:reply:assistant');
      root.setAttribute('data-markdown-text-style', 'assistant-message');
      const group = document.createElement('div');
      const portal = document.createElement('div');
      const dil = document.createElement('div');
      const p = document.createElement('p');
      p.setAttribute('data-d-component', 'text');
      p.textContent = 'tool\n' + toolJson + '\n\nI followed the requested formatting.';
      const c1 = document.createElement('code');
      c1.setAttribute('data-d-component', 'code');
      c1.textContent = 'read_file';
      const c2 = document.createElement('code');
      c2.setAttribute('data-d-component', 'code');
      c2.textContent = 'write_file';
      p.appendChild(c1);
      p.appendChild(c2);
      dil.appendChild(p);
      portal.appendChild(dil);
      group.appendChild(portal);
      root.appendChild(group);
      const turn = document.createElement('div');
      turn.setAttribute('data-content-search-unit-key', 'fixture:turn:reply:assistant');
      turn.appendChild(root);
      main.appendChild(turn);
    }, 200);
  });
  window.__LB__.call(
    'send_message',
    JSON.stringify({ text: 'create note.md please', quiet_ms: 150, timeout_ms: 4000, request_id: 'task-dil.bbbbbbbb' }),
    'send-dil',
    'jsdom-nonce'
  );
  const deadline = Date.now() + 3500;
  while (Date.now() < deadline) {
    await sleep(50);
    if (posted.some((m) => m.t === 'assistant_message')) break;
  }
  await sleep(200);
  const pushes = posted.filter((m) => m.t === 'assistant_message');
  assert.equal(pushes.length, 1, 'exactly one completion push');
  assert.ok(
    pushes[0].text.includes('```tool\n' + toolJson + '\n```'),
    'the flattened reply is re-fenced for the parser; got: ' + JSON.stringify(pushes[0].text)
  );
  assert.ok(
    pushes[0].text.includes('I followed the requested formatting.'),
    'the prose survives outside the block'
  );
  window.close();
});

test('flattened prose that merely mentions tools is never re-fenced', async () => {
  const { window, document, posted } = makeWindow();
  const { composer, send } = buildChat(document);
  const main = document.createElement('main');
  document.body.appendChild(main);
  send.addEventListener('click', () => {
    composer.value = '';
    const user = makeTurn(document, 'user', 'what can you do?');
    main.appendChild(user);
    setTimeout(() => {
      const turn = document.createElement('div');
      turn.setAttribute('data-content-search-unit-key', 'fixture:turn:reply:assistant');
      const answer = document.createElement('div');
      answer.className = 'markdown prose';
      answer.textContent = 'tool\nnot valid json; and JSON without the shape: {"a":1}\nmore prose';
      turn.appendChild(answer);
      main.appendChild(turn);
    }, 200);
  });
  window.__LB__.call(
    'send_message',
    JSON.stringify({ text: 'what can you do?', quiet_ms: 150, timeout_ms: 4000, request_id: 'task-dil-no.cccccccc' }),
    'send-dil-no',
    'jsdom-nonce'
  );
  const deadline = Date.now() + 3500;
  while (Date.now() < deadline) {
    await sleep(50);
    if (posted.some((m) => m.t === 'assistant_message')) break;
  }
  await sleep(200);
  const pushes = posted.filter((m) => m.t === 'assistant_message');
  assert.equal(pushes.length, 1, 'exactly one completion push');
  assert.ok(
    !pushes[0].text.includes('```tool'),
    'non-tool-shaped flattened text is left alone; got: ' + JSON.stringify(pushes[0].text)
  );
  window.close();
});

test('a tool-shaped JSON knob without the tool-opener line is never re-fenced', async () => {
  // A reply that merely CONTAINS the schema-shaped JSON in prose (no `tool`
  // line immediately before it) must stay prose: the opener line is part of
  // the fence contract, so wrapping bare JSON would fabricate tool calls.
  const { window, document, posted } = makeWindow();
  const { composer, send } = buildChat(document);
  const main = document.createElement('main');
  document.body.appendChild(main);
  send.addEventListener('click', () => {
    composer.value = '';
    const user = makeTurn(document, 'user', 'show me the tool json format');
    main.appendChild(user);
    setTimeout(() => {
      const turn = document.createElement('div');
      turn.setAttribute('data-content-search-unit-key', 'fixture:turn:reply:assistant');
      const answer = document.createElement('div');
      answer.className = 'markdown prose';
      answer.textContent = 'Here is the format: {"id":"1","tool":"write_file","k":"jsdom-nonce","args":{"path":"x.md","content":"hi"}} — use it in a ```tool fencing block.';
      turn.appendChild(answer);
      main.appendChild(turn);
    }, 200);
  });
  window.__LB__.call(
    'send_message',
    JSON.stringify({ text: 'show me the tool json format', quiet_ms: 150, timeout_ms: 4000, request_id: 'task-dil-no2.dddddddd' }),
    'send-dil-no2',
    'jsdom-nonce'
  );
  const deadline = Date.now() + 3500;
  while (Date.now() < deadline) {
    await sleep(50);
    if (posted.some((m) => m.t === 'assistant_message')) break;
  }
  await sleep(200);
  const pushes = posted.filter((m) => m.t === 'assistant_message');
  assert.equal(pushes.length, 1, 'exactly one completion push');
  assert.ok(
    !pushes[0].text.includes('```tool\n'),
    'bare tool-shaped JSON is not turned into a tool block; got: ' + JSON.stringify(pushes[0].text)
  );
  window.close();
});

test('a reply that already contains backticks is owned by the pre path, never double-wrapped', async () => {
  // Flattened-DIL replies cannot contain literal backticks by construction,
  // but if any backtick IS present the restorer must no-op entirely: the
  // <pre> fence reconstruction already produced real fences, and re-wrapping
  // on top could nest or duplicate ```tool blocks around ordinary examples.
  const { window, document, posted } = makeWindow();
  const { composer, send } = buildChat(document);
  const main = document.createElement('main');
  document.body.appendChild(main);
  const toolJson = '{"id":"1","tool":"write_file","k":"jsdom-nonce","args":{"path":"note.md","content":"hi"}}';
  send.addEventListener('click', () => {
    composer.value = '';
    const user = makeTurn(document, 'user', 'explain the tool format');
    main.appendChild(user);
    setTimeout(() => {
      // Paragraph carrying one real ```tool fence (from the pre path) plus a
      // SECOND unfolded copy of the JSON after a prose tool line: exactly the
      // shape a careless double-wrap would corrupt.
      const turn = document.createElement('div');
      turn.setAttribute('data-content-search-unit-key', 'fixture:turn:reply:assistant');
      const answer = document.createElement('div');
      answer.className = 'markdown prose';
      answer.textContent = '```tool\n' + toolJson + '\n```\nAnd as text it would look like: tool\n' + toolJson;
      turn.appendChild(answer);
      main.appendChild(turn);
    }, 200);
  });
  window.__LB__.call(
    'send_message',
    JSON.stringify({ text: 'explain the tool format', quiet_ms: 150, timeout_ms: 4000, request_id: 'task-dil-back.eeeeeeee' }),
    'send-dil-back',
    'jsdom-nonce'
  );
  const deadline = Date.now() + 3500;
  while (Date.now() < deadline) {
    await sleep(50);
    if (posted.some((m) => m.t === 'assistant_message')) break;
  }
  await sleep(200);
  const pushes = posted.filter((m) => m.t === 'assistant_message');
  assert.equal(pushes.length, 1, 'exactly one completion push');
  const count = (pushes[0].text.match(/```tool/g) || []).length;
  assert.equal(count, 1, 'exactly one tool fence, the one that was already fenced; got: ' + JSON.stringify(pushes[0].text));
  window.close();
});

// ---------------------------------------------------------------------------
// Phase 3O checkpoint 3: submission-budget (deadline) contract.
// Live failure reproduced here: a follow-up send after a completed reply hit
// Rust's 25s RPC wall while the page chain was still in its settle stages
// (a lingering streaming/stop control stretched waitForComposerIdle), the
// late result was discarded, and SEND_IN_FLIGHT stayed latched — the next
// task's cold start was instantly refused with "a prompt is already being
// submitted". Regressions must prove: (a) the chain resolves inside a small
// budget with a truthful "not sent" error, (b) nothing was clicked, and
// (c) the latch is gone so the very next send succeeds.

test('a lingering stop control cannot push the send chain past its budget; the latch clears for the next send', async () => {
  const { window, document, posted } = makeWindow();
  const { composer, send, main } = buildChat(document);
  // The idle wait resolves only when the streaming control is gone. Keep it
  // "generating" long enough that the old unclamped chain would run 15s+.
  const stop = rects(document.createElement('button'));
  stop.setAttribute('data-testid', 'stop-button');
  document.body.appendChild(stop);
  setTimeout(() => stop.remove(), 600);

  const t0 = Date.now();
  window.__LB__.call(
    'send_message',
    // Old behaviour: waitForComposerIdle(15000) alone exceeded this budget,
    // the RPC was cancelled, and SEND_IN_FLIGHT latched.
    JSON.stringify({ text: 'follow up prompt', quiet_ms: 100, timeout_ms: 4000, request_id: 'task-dl.aaaaaaaa', budget_ms: 1500 }),
    'send-deadline',
    'jsdom-nonce'
  );
  const result = await rpc(() => posted.find((x) => x.t === 'rpc_result' && x.id === 'send-deadline'));
  const elapsed = Date.now() - t0;
  assert.ok(result, 'the send chain resolved INSIDE the small budget (no mid-flight RPC cancel)');
  assert.ok(elapsed < 3500, 'resolves well under the unclamped ~50s worst case; took ' + elapsed + 'ms');
  const value = JSON.parse(result.v).value;
  assert.equal(value.error_type, 'deadline');
  assert.ok(value.error.includes('NOT submitted'), 'the error states the prompt was not sent: ' + value.error);

  // Nothing was clicked: no user turn, no reply watch armed, no charger.
  assert.equal(main.querySelectorAll('[data-message-author-role="user"]').length, 0);
  assert.equal(posted.filter((m) => m.t === 'assistant_message').length, 0);

  // (b) the latch is gone: an ordinary send right after works end to end.
  // Give the second send a live page (click produces the user turn + reply)
  // so it settles quickly instead of waiting out waitSubmission.
  send.addEventListener('click', () => {
    composer.value = '';
    main.appendChild(makeTurn(document, 'user', 'next prompt'));
    main.appendChild(makeTurn(document, 'assistant', 'done'));
  });
  window.__LB__.call(
    'send_message',
    JSON.stringify({ text: 'next prompt', quiet_ms: 100, timeout_ms: 4000, request_id: 'task-dl.bbbbbbbb', budget_ms: 12000 }),
    'send-after-deadline',
    'jsdom-nonce'
  );
  await sleep(100);
  const pushed = posted.find((m) => m.t === 'assistant_message');
  const settled2 = await rpc(() => posted.find((m) => m.t === 'rpc_result' && m.id === 'send-after-deadline'));
  assert.ok(settled2 || pushed, 'the second send is accepted and settles, not refused as busy');
  if (pushed) assert.equal(pushed.request_id, 'task-dl.bbbbbbbb');
  window.close();
});

test('the click gate refuses only when the confirm window cannot fit, and keeps honest success otherwise', async () => {
  const { window, document, posted } = makeWindow();
  const { composer, send, main } = buildChat(document);
  send.addEventListener('click', () => {
    composer.value = '';
    main.appendChild(makeTurn(document, 'user', 'hello there'));
    main.appendChild(makeTurn(document, 'assistant', 'hello!'));
  });
  // A meaty budget (12s > the 8.5s confirm window + settle stages) with a
  // normal page: the click still happens and the reply push carries the bound
  // request id.
  window.__LB__.call(
    'send_message',
    JSON.stringify({ text: 'hello there', quiet_ms: 100, timeout_ms: 4000, request_id: 'task-g.aaaaaaaa', budget_ms: 12000 }),
    'send-ok',
    'jsdom-nonce'
  );
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await sleep(50);
    if (posted.some((m) => m.t === 'assistant_message')) break;
  }
  const pushes = posted.filter((m) => m.t === 'assistant_message');
  assert.equal(pushes.length, 1, 'healthy sends still push the reply');
  assert.equal(pushes[0].request_id, 'task-g.aaaaaaaa');

  // A budget that expires before the click: refuse truthfully, no user turn.
  window.__LB__.call(
    'send_message',
    JSON.stringify({ text: 'late prompt', quiet_ms: 100, timeout_ms: 4000, request_id: 'task-g.bbbbbbbb', budget_ms: 1 }),
    'send-late',
    'jsdom-nonce'
  );
  const lateResult = await rpc(() => posted.find((x) => x.t === 'rpc_result' && x.id === 'send-late'));
  assert.ok(lateResult, 'a 1ms budget still resolves instead of hanging');
  const lateValue = JSON.parse(lateResult.v).value;
  if (lateValue.error_type === 'deadline') {
    assert.ok(lateValue.error.includes('NOT submitted'));
    const users = main.querySelectorAll('[data-message-author-role="user"]');
    assert.ok(![...users].some((u) => u.textContent === 'late prompt'), 'the late prompt was never composed into a user turn');
  } else {
    // Worst case timing race resolved the other way; either report is truthful.
    assert.ok(lateValue.sent || lateValue.error_type === 'page_changed' || lateValue.error_type === 'busy', JSON.stringify(lateValue));
  }
  window.close();
});

// Live follow-up submission reproduced here (rpc r9, 25s wall): the chain
// stalled INSIDE pageSettle — its readyState=="complete" branch resolved via
// requestAnimationFrame WITHOUT arming the fallback timer, and Chromium fully
// suspends rAF while the active task's provider webview is hidden. The settle
// promise therefore never resolved, the send RPC was cancelled at 25s, and
// SEND_IN_FLIGHT latched, refusing the next task's cold start with "a prompt
// is already being submitted".
test('a hidden provider page with suspended rAF cannot stall the send chain in pageSettle', async () => {
  const { window, document, posted } = makeWindow();
  const { composer, send, main } = buildChat(document);
  // Nobody ever runs the animation frame callback: what a hidden WebView2
  // document effectively does to rAF.
  window.requestAnimationFrame = function () { return 42; };
  send.addEventListener('click', () => {
    composer.value = '';
    main.appendChild(makeTurn(document, 'user', 'settle probe'));
    main.appendChild(makeTurn(document, 'assistant', 'SETTLE OK'));
  });
  window.__LB__.call(
    'send_message',
    JSON.stringify({ text: 'settle probe', quiet_ms: 100, timeout_ms: 4000, request_id: 'task-ps.aaaaaaaa', budget_ms: 12000 }),
    'send-settle',
    'jsdom-nonce'
  );
  // Old behaviour: NOTHING ever resolved (no push, no rpc result, SEND_IN_FLIGHT
  // latched). The fallback settle timer must fire and the submission proceed.
  const deadline = Date.now() + 9000;
  let hit = null;
  while (Date.now() < deadline) {
    await sleep(100);
    hit = posted.find((m) => m.t === 'assistant_message' || (m.t === 'rpc_result' && m.id === 'send-settle'));
    if (hit) break;
  }
  assert.ok(hit, 'the chain resolved despite a dead rAF (settle timer armed in every branch)');
  if (hit.t === 'assistant_message') {
    assert.equal(hit.request_id, 'task-ps.aaaaaaaa');
  } else {
    const v = JSON.parse(hit.v).value;
    assert.ok(v.sent || v.error, 'the send settled with an honest outcome: ' + JSON.stringify(v));
  }
  // And the latch is probeable: a second send is accepted, never refused as busy.
  window.__LB__.call(
    'send_message',
    JSON.stringify({ text: 'settle probe', quiet_ms: 100, timeout_ms: 4000, request_id: 'task-ps.bbbbbbbb', budget_ms: 12000 }),
    'send-settle2',
    'jsdom-nonce'
  );
  const r2 = await rpc(() => posted.find((x) => x.t === 'rpc_result' && x.id === 'send-settle2'));
  const pushed2 = posted.some((m) => m.t === 'assistant_message');
  // Either resolution is fine; what must NOT happen is a busy refusal.
  if (r2) {
    const v2 = JSON.parse(r2.v).value;
    assert.notEqual(v2.error_type, 'busy', 'the latch must not survive the settle fix');
  }
  assert.ok(r2 || pushed2, 'the second send proceeds');
  window.close();
});
