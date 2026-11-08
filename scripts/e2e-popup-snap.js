'use strict';
// Read the popup page's visible status lists (requests + activity) as the user sees them.
(async () => {
  const http = require('http');
  const EXT = 'gcjjbofmdcdfdofapeefmdgkldpibokp';
  function getJson(path) {
    return new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: 9222, path }, (res) => {
        let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(JSON.parse(d)));
      }).on('error', reject);
    });
  }
  function wsConnect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url); ws.onopen = () => resolve(ws); ws.onerror = () => reject(new Error('ws error'));
      setTimeout(() => reject(new Error('ws open timeout')), 5000);
    });
  }
  let nextId = 0;
  function cdp(ws, method, params, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const onMsg = (ev) => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', onMsg); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } };
      ws.addEventListener('message', onMsg); ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { ws.removeEventListener('message', onMsg); reject(new Error(method + ' timeout')); }, timeoutMs);
    });
  }
  async function evalExpr(ws, expression) {
    const r = await cdp(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('EvalException: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result && r.result.value;
  }
  const targets = await getJson('/json/list');
  const t = targets.find((x) => x.type === 'page' && x.url.startsWith(`chrome-extension://${EXT}/popup`));
  if (!t) throw new Error('popup page target missing');
  // Reload the popup page so it renders the latest stored requests/activity.
  const ws = await wsConnect(t.webSocketDebuggerUrl);
  await cdp(ws, 'Page.enable');
  await cdp(ws, 'Page.reload', { ignoreCache: false });
  await new Promise((r) => setTimeout(r, 2500));
  const out = await evalExpr(ws, `(() => {
    const text = (sel) => Array.from(document.querySelectorAll(sel)).map((n) => (n.textContent || '').trim()).filter(Boolean);
    const conn = text('.conn-dot, [class*=conn]');
    const reqs = text('.request-item, [class*=request]').slice(0, 12);
    const acts = text('.activity-item, [class*=activity], .act-row, li').slice(0, 18);
    return { conn, reqs, acts, bodyHead: document.body.innerText.slice(0, 1800) };
  })()`);
  console.log(JSON.stringify(out, null, 1));
  ws.close(); process.exit(0);
})().catch((e) => { console.error('POPUPSNAP-ERROR', e && e.message); process.exit(1); });
