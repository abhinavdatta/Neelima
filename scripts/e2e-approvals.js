'use strict';
// Approval-card observer for the Tauri WebView2 UI via CDP.
// Usage:
//   node scripts/e2e-approvals.js snapshot
//   node scripts/e2e-approvals.js click "Approve"
const http = require('http');

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 9230, path }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}
function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('ws error'));
    setTimeout(() => reject(new Error('ws open timeout')), 5000);
  });
}
let nextId = 0;
function cdp(ws, method, params, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) {
        ws.removeEventListener('message', onMsg);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { ws.removeEventListener('message', onMsg); reject(new Error(method + ' timeout')); }, timeoutMs);
  });
}
async function evalExpr(ws, expression) {
  const r = await cdp(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('EvalException: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
  return r.result && r.result.value;
}

const SNAPSHOT_EXPR = `(() => {
  const texts = [];
  const walk = (el) => {
    const kids = Array.from(el.children || []);
    for (const n of kids) {
      const tag = String(n.tagName);
      if (tag === 'STYLE' || tag === 'SCRIPT') continue;
      const ideal = Array.from(n.childNodes || []).filter((c) => c.nodeType === 3).map((c) => String(c.nodeValue)).join('').trim();
      if (ideal) texts.push({ tag, cls: String(n.className || '').slice(0, 60), text: ideal.slice(0, 140) });
      if (texts.length > 150) return;
      walk(n);
    }
  };
  walk(document.body);
  return texts;
})()`;

(async () => {
  const cmd = process.argv[2];
  const targets = await getJson('/json/list');
  const t = targets.find((x) => x.type === 'page' && x.url.startsWith('http://tauri.localhost'));
  if (!t) throw new Error('Neelima webview target missing');
  const ws = await wsConnect(t.webSocketDebuggerUrl);
  await cdp(ws, 'Runtime.enable');
  if (cmd === 'snapshot') {
    console.log(JSON.stringify(await evalExpr(ws, SNAPSHOT_EXPR), null, 1));
  } else if (cmd === 'clickwatch') {
    const label2 = process.argv[3];
    const expr = `(async () => {
      const btns = Array.from(document.querySelectorAll('button, [role=button], a'));
      const b = btns.find((n) => (n.textContent || '').trim().toLowerCase().includes(${JSON.stringify(label2.toLowerCase())}));
      if (!b) return { clicked: false, buttons: btns.map((n) => (n.textContent || '').trim().slice(0, 30)) };
      const toasts = [];
      const sample = () => Array.from(document.querySelectorAll('.toast, [class*=toast], [class*=Toast]')).map((n) => (n.textContent || '').trim()).filter(Boolean);
      for (let i = 0; i < 40; i++) {
        const s = sample();
        for (const line of s) if (!toasts.includes(line)) toasts.push(line);
        if (i === 0) b.click();
        await new Promise((r) => setTimeout(r, 150));
        if (!document.querySelector('.approval-card')) break;
      }
      return { clicked: true, text: (b.textContent || '').trim(), toasts, cardStill: Boolean(document.querySelector('.approval-card')), cardText: (document.querySelector('.approval-card') || { textContent: '' }).textContent.slice(0, 400) };
    })()`;
    console.log(JSON.stringify(await evalExpr(ws, expr), null, 1));
  }
  ws.close();
  process.exit(0);
})().catch((e) => { console.error('APPROVALS-ERROR', e.message); process.exit(1); });
