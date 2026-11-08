'use strict';
(async () => {
  const http = require('http');
  function getJson(path) {
    return new Promise((res, rej) => {
      http.get({ host: '127.0.0.1', port: 9222, path }, (r) => {
        let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d)));
      }).on('error', rej);
    });
  }
  function wsConnect(url) {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url); ws.onopen = () => res(ws); ws.onerror = () => rej(new Error('ws'));
      setTimeout(() => rej(new Error('t')), 5000);
    });
  }
  let nid = 0;
  function cdp(ws, m, p, tmo = 10000) {
    return new Promise((res, rej) => {
      const id = ++nid;
      const on = (ev) => { const x = JSON.parse(ev.data); if (x.id === id) { ws.removeEventListener('message', on); x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result); } };
      ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params: p }));
      setTimeout(() => rej(new Error(m + ' timeout')), tmo);
    });
  }
  async function evalIn(ws, expr) {
    const v = await cdp(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return v.result.value;
  }
  const ts = await getJson('/json/list');
  const t = ts.find((x) => x.type === 'service_worker' && x.url.includes('background.js'));
  const ws = await wsConnect(t.webSocketDebuggerUrl);
  const requests = await evalIn(ws, "(async()=>{const r=await chrome.storage.local.get('neelima.requests.v1');return JSON.stringify((r['neelima.requests.v1']||[]).slice(-4))})()");
  console.log('REQUESTS:', requests);
  const activity = await evalIn(ws, "(async()=>{const r=await chrome.storage.local.get('neelima.activity.v1');return JSON.stringify((r['neelima.activity.v1']||[]).slice(-6))})()");
  console.log('ACTIVITY:', activity);
  const portState = await evalIn(ws, "JSON.stringify({ port: Boolean(nativePort), connectionError: connectionError || null, pending: pending.size, recent: [...recentProposals.entries()].map(([k, v]) => k + ' -> ' + JSON.stringify(v.reply || null)) })");
  console.log('PORT STATE:', portState);
  ws.close();
  process.exit(0);
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
