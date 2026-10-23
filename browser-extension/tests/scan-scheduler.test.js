'use strict';
// Deterministic tests for content/scan-scheduler.js, the shared mutation
// scheduler used by every provider content script.
//
// Regression target: each provider script used to run a full
// `document.querySelectorAll` pass on EVERY mutation, and `addButton` then
// called `message.textContent` (which serializes the whole subtree). During
// streaming that is dozens of full-document passes per second. These tests pin
// the replacement contract: coalesce, process only changed nodes, ignore our own
// UI, and still recover after a structural change.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const schedulerSource = fs.readFileSync(
  path.join(__dirname, '../content/scan-scheduler.js'),
  'utf8'
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function page() {
  const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', {
    url: 'https://chatgpt.com/c/test',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  window.eval(schedulerSource);
  return { window, document: window.document };
}

function message(document, text) {
  const el = document.createElement('div');
  el.className = 'msg';
  el.textContent = text;
  return el;
}

test('a mutation storm is coalesced into one pass per changed node', async () => {
  const { window, document } = page();
  const main = document.querySelector('main');
  const seen = [];
  window.__NEELIMA_SCAN__.watch({
    selectors: ['.msg'],
    intervalMs: 20,
    onNode: (el) => seen.push(el.textContent),
  });
  await sleep(40); // initial full pass on an empty transcript
  assert.equal(seen.length, 0);

  // 30 messages appended in one synchronous burst (what a streaming renderer
  // looks like to the observer).
  for (let i = 0; i < 30; i += 1) main.appendChild(message(document, `m${i}`));
  await sleep(80);

  assert.equal(seen.length, 30, `each new message processed exactly once, got ${seen.length}`);
  assert.equal(new Set(seen).size, 30, 'no duplicate processing');

  // Quiet page: no further work.
  await sleep(80);
  assert.equal(seen.length, 30, 'no rescans while nothing changes');
  window.close();
});

test('Neelima-owned UI never triggers a rescan of the transcript', async () => {
  const { window, document } = page();
  const main = document.querySelector('main');
  const seen = [];
  window.__NEELIMA_SCAN__.watch({
    selectors: ['.msg'],
    intervalMs: 20,
    onNode: (el) => seen.push(el),
  });
  await sleep(40);

  const turn = message(document, 'answer');
  main.appendChild(turn);
  await sleep(60);
  assert.equal(seen.length, 1, 'the message is processed once');

  // Our own review button carries the message class and the own marker; adding
  // it must not schedule another pass (it used to re-trigger the old scan).
  const button = document.createElement('button');
  button.className = 'msg';
  button.setAttribute('data-neelima-review-button', 'true');
  button.setAttribute('data-neelima-own', 'true');
  turn.appendChild(button);
  await sleep(80);

  assert.equal(seen.length, 1, 'own UI is ignored');
  window.close();
});

test('a removed node triggers one bounded rescan that still finds the transcript', async () => {
  const { window, document } = page();
  const main = document.querySelector('main');
  const first = message(document, 'one');
  const second = message(document, 'two');
  main.appendChild(first);
  main.appendChild(second);

  const seen = [];
  window.__NEELIMA_SCAN__.watch({
    selectors: ['.msg'],
    intervalMs: 20,
    onNode: (el) => seen.push(el.textContent),
  });
  await sleep(40);
  assert.deepEqual(seen.sort(), ['one', 'two'], 'initial pass covers rendered messages');

  seen.length = 0;
  first.remove(); // edit / collapse / virtualized rerender
  await sleep(80);
  // A structural change re-processes the surviving message once — it does not
  // fan out into a scan storm.
  assert.ok(seen.includes('two'), 'surviving message is re-processed');
  assert.ok(seen.length <= 2, `bounded rescan, got ${seen.length}`);
  window.close();
});

test('the scheduler observes the transcript container when one exists', async () => {
  const { window, document } = page();
  const main = document.querySelector('main');
  const seen = [];
  const handle = window.__NEELIMA_SCAN__.watch({
    selectors: ['.msg'],
    intervalMs: 20,
    onNode: (el) => seen.push(el.textContent),
  });
  await sleep(40);
  // Mutating inside <main> is observed; mutating a detached tree is not.
  const detached = document.createElement('div');
  const ghost = message(document, 'ghost');
  detached.appendChild(ghost);
  await sleep(60);
  assert.equal(seen.includes('ghost'), false, 'detached subtrees are not scanned');

  main.appendChild(message(document, 'live'));
  await sleep(60);
  assert.ok(seen.includes('live'), 'the conversation container is observed');
  handle.disconnect();
  window.close();
});
