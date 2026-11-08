'use strict';
// Usage:
//   node scripts/e2e-tx.js propose "<tool=plainjso>" "<proposalJSON>"   -> sends manual propose from REAL popup, polls result
//   node scripts/e2e-tx.js poll                                        -> fetch last stored result
const EXT_ID = 'gcjjbofmdcdfdofapeefmdgkldpibokp';
const KEY = 'e2e.tx.' + (process.argv[4] || 'x');
const POLL_MS = 300;

async function http(path) {
  const res = await fetch(`http://127.0.0.1:9222${path}`);
  if (!res.ok) throw new Error(`CDP ${path} -> ${res.status}`);
  return res.json();
}
function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('ws error'));
    setTimeout(() => reject(new Error('ws open timeout')), 5000);
  });
}
async function cdp(ws, id, method, params, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', onMsg); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { ws.removeEventListener('message', onMsg); reject(new Error(`cdp ${method} timeout`)); }, timeoutMs);
  });
}
async function evalExpr(ws, nextId, expression) {
  const r = await cdp(ws, nextId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, 10000);
  if (r.exceptionDetails) throw new Error('EvalException: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
  return r.result && r.result.value;
}
async function findPopup() {
  const targets = await http('/json/list');
  const t = targets.find(x => x.type === 'page' && x.url === `chrome-extension://${EXT_ID}/popup/index.html`);
  if (!t) throw new Error('popup page target missing');
  return t.webSocketDebuggerUrl;
}
async function readStorage(ws, nextId) {
  const v = await evalExpr(ws, nextId, `(async () => { const d = await chrome.storage.local.get(${JSON.stringify(KEY)}); const raw = d[${JSON.stringify(KEY)}]; return raw === undefined ? undefined : { raw, keys: Object.keys(raw || {}), type: typeof raw }; })()`);
  return v;
}
(async () => {
  const cmd = process.argv[2];
  const idSuffix = process.argv[4] || 'tx';
  const wsUrl = await findPopup();
  const ws = await wsConnect(wsUrl);
  await cdp(ws, 1, 'Runtime.enable');
  let id = 1;
  if (cmd === 'poll') {
    const v = await readStorage(ws, ++id);
    console.log(JSON.stringify(v));
  } else if (cmd === 'propose') {
    const proposal = JSON.parse(process.argv[3]);
    // clear slot, launch without awaiting (storage handoff), then poll
    await evalExpr(ws, ++id, `(async () => { await chrome.storage.local.remove(${JSON.stringify(KEY)}); await chrome.storage.local.remove('e2e.probe'); return 'removed'; })()`);
    const launchExpr = `(async () => {
      const KEY = ${JSON.stringify(KEY)};
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs && tabs[0];
      try {
        if (!tab) throw new Error('No active tab.');
        if (!tab.id === undefined) throw new Error('bad tab');
        if (typeof tab.url !== 'string' || !tab.url) throw new Error('Active tab URL not visible (activeTab not granted).');
        await chrome.storage.local.set({ 'e2e.probe': 'sent' });
        chrome.runtime.sendMessage({ type: 'NEELIMA_MANUAL_PROPOSE', tabId: tab.id, url: tab.url, proposal: ${JSON.stringify(proposal)} }, (resp) => {
          const err = chrome.runtime.lastError;
          chrome.storage.local.set({ [KEY]: err ? { resolved: true, lastError: err.message } : { resolved: true, respType: typeof resp, resp: resp === undefined ? null : resp } });
        });
        return 'launched';
      } catch (e) {
        await chrome.storage.local.set({ [KEY]: { aborted: String(e && e.message || e), tabUrl: tab && tab.url } });
      }
    })()`;
    await evalExpr(ws, ++id, launchExpr);
    for (let i = 0; i < 400; i++) {
      await new Promise(r => setTimeout(r, POLL_MS));
      const v = await readStorage(ws, ++id).catch(() => null);
      if (v !== undefined && v !== null) {
        const acts = await evalExpr(ws, ++id, `(async () => { const [a, r] = await chrome.storage.local.get(['neelima.activity.v1', 'neelima.requests.v1']); return { activity: (a['neelima.activity.v1'] || []).slice(-6), requests: (r['neelima.requests.v1'] || []).slice(-6) }; })()`).catch(() => { return { error: 'activity read failed' }; });
        console.log(JSON.stringify({ stored: v, activity: acts }));
        process.exit(0);
      }
    }
    console.log(JSON.stringify({ error: 'poll-timeout' }));
  }
  process.exit(0);
})().catch(e => { console.error('TX-ERROR', e.message); process.exit(1); });
