'use strict';
// The provider content script wired to the shared scheduler: a tool block in an
// assistant message gets exactly ONE review button (no duplicates across
// renders), and clicking it sends a proposal through the extension runtime.
// `chrome.runtime.sendMessage` is mocked; nothing here proves a live browser
// round trip.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const schedulerSource = fs.readFileSync(path.join(__dirname, '../content/scan-scheduler.js'), 'utf8');
const chatgptSource = fs.readFileSync(path.join(__dirname, '../content/chatgpt.js'), 'utf8');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function page() {
  const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', {
    url: 'https://chatgpt.com/c/test',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const sent = [];
  window.chrome = {
    runtime: {
      async sendMessage(message) {
        sent.push(message);
        return { ok: true, status: 'completed', message: 'Tool executed.' };
      },
    },
  };
  window.eval(schedulerSource);
  window.eval(chatgptSource);
  return { window, document: window.document, sent };
}

function assistantMessage(document, text) {
  const el = document.createElement('div');
  el.setAttribute('data-message-author-role', 'assistant');
  el.textContent = text;
  return el;
}

const TOOL_BLOCK = 'Let me look.\n```neelima-tool\n{"tool":"read_file","args":{"path":"src/main.rs"}}\n```';

test('one review button per tool block, even across a render storm', async () => {
  const { window, document } = page();
  const main = document.querySelector('main');

  main.appendChild(assistantMessage(document, TOOL_BLOCK));
  await sleep(300);
  const buttons = () => document.querySelectorAll('[data-neelima-review-button]');
  assert.equal(buttons().length, 1, 'a tool block gets exactly one review button');

  // Provider re-renders the message (new children, same content) several times.
  for (let i = 0; i < 5; i += 1) {
    const el = assistantMessage(document, TOOL_BLOCK);
    main.appendChild(el);
    await sleep(40);
  }
  await sleep(300);
  assert.equal(buttons().length, 6, 'each message gets one button, never two on the same message');
  for (const message of document.querySelectorAll('[data-message-author-role="assistant"]')) {
    assert.equal(
      message.querySelectorAll('[data-neelima-review-button]').length,
      1,
      'no duplicate control inside a message'
    );
  }
  window.close();
});

test('a message without a tool block gets no control at all', async () => {
  const { window, document } = page();
  document.querySelector('main').appendChild(assistantMessage(document, 'just prose, no tool call'));
  await sleep(300);
  assert.equal(document.querySelectorAll('[data-neelima-review-button]').length, 0);
  window.close();
});

test('clicking review sends the proposal with site identity and user activation', async () => {
  const { window, document, sent } = page();
  document.querySelector('main').appendChild(assistantMessage(document, TOOL_BLOCK));
  await sleep(300);

  const button = document.querySelector('[data-neelima-review-button]');
  button.click();
  await sleep(60);

  assert.equal(sent.length, 1, 'exactly one proposal');
  assert.equal(sent[0].type, 'NEELIMA_PROPOSE_TOOL');
  assert.equal(sent[0].proposal.tool, 'read_file');
  // (Cross-realm object: compare fields, not deepStrictEqual prototypes.)
  assert.equal(sent[0].proposal.args.path, 'src/main.rs');
  assert.equal(sent[0].proposal.site, 'chatgpt');
  assert.equal(sent[0].proposal.page_origin, 'https://chatgpt.com');
  assert.equal(sent[0].proposal.user_activated, true, 'a human click is recorded');
  assert.match(button.textContent, /Request sent to Neelima/);

  // The status panel is our own UI: it must be marked as such so the scheduler
  // never treats it as page content.
  const panel = document.querySelector('[data-neelima-review-panel]');
  assert.ok(panel, 'status panel is shown');
  assert.equal(panel.getAttribute('data-neelima-own'), 'true');
  window.close();
});

test('a rejected proposal restores the button and explains the failure', async () => {
  const { window, document } = page();
  window.chrome.runtime.sendMessage = async () => ({ ok: false, error: 'no workspace open' });
  document.querySelector('main').appendChild(assistantMessage(document, TOOL_BLOCK));
  await sleep(300);

  const button = document.querySelector('[data-neelima-review-button]');
  button.click();
  await sleep(60);

  assert.equal(button.disabled, false, 'the button is usable again');
  assert.match(button.textContent, /Review in Neelima/);
  assert.match(document.querySelector('[data-neelima-review-panel]').textContent, /no workspace open/);
  window.close();
});
