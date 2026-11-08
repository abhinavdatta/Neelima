'use strict';
// Invoke browser_bridge_decide exactly like the UI button does, and report the raw result.
(async () => {
  const http = require('http');
  function getJson(path) {
    return new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: 9230, path }, (res) => {
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
  const t = targets.find((x) => x.type === 'page' && x.url.startsWith('http://tauri.localhost'));
  if (!t) throw new Error('Neelima webview target missing');
  const ws = await wsConnect(t.webSocketDebuggerUrl);

  const probe = await evalExpr(ws, `(() => {
    const card = document.querySelector('.approval-card');
    const argPre = card ? card.querySelector('pre.tool-args') : null;
    const internals = window.__TAURI_INTERNALS__;
    return {
      cardPresent: Boolean(card),
      argText: argPre ? argPre.textContent.slice(0, 200) : null,
      hasInternals: typeof internals !== 'undefined',
      invokeType: internals ? typeof internals.invoke : null
    };
  })()`);
  console.log('PROBE', JSON.stringify(probe));
  if (process.argv[2] === 'invoke') {
    const res = await evalExpr(ws, `window.__TAURI_INTERNALS__.invoke('browser_bridge_decide', { requestId: ${JSON.stringify(process.argv[3] || null)}, approved: true, reason: null })
      .then((r) => ({ ok: true, result: r }))
      .catch((e) => ({ ok: false, error: typeof e === 'string' ? e : JSON.stringify(e) }))`);
    console.log('INVOKE', JSON.stringify(res));
  }
  ws.close(); process.exit(0);
})().catch((e) => { console.error('DIAG2-ERROR', e.message); process.exit(1); });
