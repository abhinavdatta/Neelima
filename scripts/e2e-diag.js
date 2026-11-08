'use strict';
// Diagnostic eval in the Tauri webview: is __TAURI__ global present? Any toasts? Bridge state store?
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
  const expr = `(() => {
    const toasts = Array.from(document.querySelectorAll('.toast, [class*=toast]')).map((n) => (n.textContent || '').trim()).filter(Boolean);
    return {
      hasTauri: typeof window.__TAURI__ !== 'undefined',
      tauriKeys: typeof window.__TAURI__ !== 'undefined' ? Object.keys(window.__TAURI__) : null,
      toasts,
      btnOk: Array.from(document.querySelectorAll('button.btn-ok')).map((n) => ({ text: (n.textContent || '').trim(), disabled: n.disabled })),
      btnNo: Array.from(document.querySelectorAll('button.btn-no')).map((n) => ({ text: (n.textContent || '').trim(), disabled: n.disabled }))
    };
  })()`;
  console.log(JSON.stringify(await evalExpr(ws, expr), null, 1));
  ws.close(); process.exit(0);
})().catch((e) => { console.error('DIAG-ERROR', e.message); process.exit(1); });
