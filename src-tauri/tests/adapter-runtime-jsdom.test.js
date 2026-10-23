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

// ---- attribute-free layout (the live chatgpt.com case) ----------------------
// A live session reported: layout=user-anchor, assistant turns=2, text empty.
// The page exposed NO data-message-author-role and NO data-testid
// conversation-turn wrappers, so every attribute detector found nothing and the
// sibling heuristic returned an empty container. The answer must be found from
// content structure instead: the last non-empty content block after the prompt.

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
  const { window, document, posted } = makeWindow();
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
  const { window, document, posted } = makeWindow();
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
