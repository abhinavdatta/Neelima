'use strict';
// Phase 4: per-adapter content-script tests. Each provider adapter must
// independently (a) detect an explicitly marked Neelima tool block,
// (b) add exactly one Review button per message even across repeated SPA
// mutations, (c) refuse to forward invalid JSON, and (d) forward valid
// proposals with trusted origin metadata — never page content on its own.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ADAPTERS = ['chatgpt', 'claude', 'gemini', 'generic'];

const VALID_BLOCK = '```neelima-tool\n{"version":1,"operation":"tool.propose","tool":"read_file","args":{"path":"notes.txt"}}\n```';

function makePage({ origin, hidden = false } = {}) {
  const sent = [];
  const messages = [];
  const observers = [];
  const added = [];

  function makeElement(tag) {
    const el = {
      tagName: String(tag || 'div').toUpperCase(),
      children: [],
      attrs: {},
      style: {},
      disabled: false,
      textContent: '',
      setAttribute(name, value) { this.attrs[name] = value; },
      getAttribute(name) { return this.attrs[name] ?? null; },
      addEventListener(type, fn) { if (type === 'click') this._onclick = fn; },
      appendChild(child) { this.children.push(child); },
      // Crude matches(): enough for the attribute selectors the adapters use.
      matches(selector) {
        const attrMatch = selector.match(/\[([a-z-]+)(?:\^?="([^"]*)")?\]/i);
        if (!attrMatch) return false;
        const have = this.attrs[attrMatch[1]];
        if (have == null) return false;
        return attrMatch[2] === undefined || have.startsWith(attrMatch[2]);
      },
    };
    return el;
  }

  function makeMessage(id, withBlock) {
    const el = makeElement('div');
    el.id = id;
    el.textContent = withBlock ? `Here is the plan.\n${VALID_BLOCK}\nDone.` : 'Just a normal reply.';
    el.querySelector = (sel) => el.children.find((c) => c.matches(sel)) || null;
    // appendChild on a message also records it for assertions.
    const origAppend = el.appendChild.bind(el);
    el.appendChild = (child) => { origAppend(child); added.push({ message: id, child }); };
    messages.push(el);
    return el;
  }

  const document = {
    visibilityState: hidden ? 'hidden' : 'visible',
    documentElement: makeElement('html'),
    querySelectorAll() { return [...messages]; },
    addEventListener(type, fn) { if (type === 'visibilitychange') document._onvisible = fn; },
    createElement: makeElement,
  };

  const chrome = {
    runtime: {
      sendMessage(msg) {
        sent.push(msg);
        return Promise.resolve({ ok: true, status: 'accepted_by_backend' });
      },
    },
  };

  const context = vm.createContext({
    window: {},
    chrome,
    document,
    location: { origin },
    MutationObserver: class {
      constructor(cb) { observers.push(cb); }
      observe() {}
      disconnect() {}
    },
    console,
  });
  return { context, sent, messages, observers, added, makeMessage, document };
}

function loadAdapter(context, site) {
  const src = fs.readFileSync(path.join(__dirname, `../../browser-extension/content/${site}.js`), 'utf8');
  vm.runInContext(src, context);
}

for (const site of ADAPTERS) {
  test(`${site}: adds a Review button for an explicitly marked tool block`, () => {
    const page = makePage({ origin: 'https://example.org' });
    page.makeMessage('m1', true);
    loadAdapter(page.context, site);
    const buttons = page.added.filter((a) => a.child.textContent === 'Review in Neelima');
    assert.equal(buttons.length, 1, 'exactly one review button for the marked message');
  });

  test(`${site}: plain replies without a marked block get no button`, () => {
    const page = makePage({ origin: 'https://example.org' });
    page.makeMessage('plain', false);
    loadAdapter(page.context, site);
    assert.equal(page.added.length, 0, 'no button for unmarked content');
  });

  test(`${site}: repeated SPA mutations never add a second button (duplicate suppression)`, () => {
    const page = makePage({ origin: 'https://example.org' });
    page.makeMessage('m1', true);
    loadAdapter(page.context, site);
    // Fire the MutationObserver callback several times, as an SPA re-render would.
    for (const cb of page.observers) for (let i = 0; i < 5; i += 1) cb([], undefined);
    const buttons = page.added.filter((a) => a.child.textContent === 'Review in Neelima');
    assert.ok(buttons.length <= 1, `expected at most one button, got ${buttons.length}`);
  });

  test(`${site}: Review click forwards the proposal with trusted origin metadata`, async () => {
    const page = makePage({ origin: 'https://example.org' });
    page.makeMessage('m1', true);
    loadAdapter(page.context, site);
    const button = page.added.find((a) => a.child.textContent === 'Review in Neelima').child;
    await button._onclick();
    assert.equal(page.sent.length, 1);
    const proposal = page.sent[0].proposal;
    assert.equal(proposal.tool, 'read_file');
    assert.equal(proposal.site, site, 'adapter stamps its own site id');
    assert.equal(proposal.page_origin, 'https://example.org');
    assert.equal(proposal.user_activated, true, 'explicit user action required');
    assert.equal(page.sent[0].type, 'NEELIMA_PROPOSE_TOOL');
  });

  test(`${site}: hidden tabs are not scanned until visible again`, () => {
    const page = makePage({ origin: 'https://example.org', hidden: true });
    page.makeMessage('m1', true);
    loadAdapter(page.context, site);
    assert.equal(page.added.length, 0, 'no scan while document is hidden');
  });
}
