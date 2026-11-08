'use strict';
// Usage: node scripts/e2e-opentab.js popup|anchor
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
(async () => {
  const cmd = process.argv[2];
  const browser = (await getJson('/json/version')).webSocketDebuggerUrl;
  const ws = await wsConnect(browser);
  if (cmd === 'popup') {
    const r = await cdp(ws, 'Target.createTarget', { url: `chrome-extension://${EXT}/popup/index.html` });
    console.log('popup target ' + r.targetId);
  } else if (cmd === 'anchor') {
    const ts = await getJson('/json/list');
    const chat = ts.find((x) => x.type === 'page' && x.url.startsWith('https://chatgpt.com'));
    if (!chat) throw new Error('chatgpt anchor tab missing');
    await cdp(ws, 'Target.activateTarget', { targetId: chat.id });
    console.log('activated ' + chat.url);
  } else if (cmd === 'closepopup') {
    const ts = await getJson('/json/list');
    for (const t of ts.filter((x) => x.type === 'page' && x.url.startsWith(`chrome-extension://${EXT}/popup`))) {
      await cdp(ws, 'Target.closeTarget', { targetId: t.id });
      console.log('closed ' + t.id);
    }
  }
  ws.close(); process.exit(0);
})().catch((e) => { console.error('OPENTAB-ERROR', e.message); process.exit(1); });
