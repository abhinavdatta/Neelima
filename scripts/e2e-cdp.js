// CDP driver for the Neelima browser-bridge E2E. Uses Node >=22 global WebSocket.
'use strict';
const CDP_PORT = 9222;
const EXT_ID = 'gcjjbofmdcdfdofapeefmdgkldpibokp'; // pinned by the native-host manifest

async function http(path) {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}${path}`);
  if (!res.ok) throw new Error(`CDP ${path} -> ${res.status}`);
  return res.json();
}

class Conn {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    const conn = new Conn(ws);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = (e) => reject(new Error('ws error')); ws.onmessage = (ev) => conn._onmessage(ev.data); });
    try { await conn.send('Runtime.enable'); } catch (_) { /* Not all targets support it; evaluation still works on pages. */ }
    return conn;
  }
  _onmessage(data) {
    const msg = JSON.parse(data);
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
      else resolve(msg.result);
    } else if (msg.method) {
      this.events.push(msg);
    }
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP ${method} timed out`)); } }, 30000);
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`Eval exception: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch (_) {} }
}

async function main() {
  const cmd = process.argv[2] || 'help';
  const arg = process.argv[3] || '';
  if (cmd === 'list') {
    const targets = await http('/json/list');
    for (const t of targets) console.log(`${t.type}  ${t.url}  ${t.webSocketDebuggerUrl ? 'ws-ok' : 'no-ws'}`);
  } else if (cmd === 'browser') {
    const v = await http('/json/version');
    const conn = await Conn.connect(v.webSocketDebuggerUrl);
    console.log(JSON.stringify(await conn.send('SystemInfo.getInfo').catch((e) => ({ err: String(e) }))), null, 2);
    conn.close();
  } else if (cmd === 'load-unpacked') {
    const v = await http('/json/version');
    const conn = await Conn.connect(v.webSocketDebuggerUrl);
    try {
      const r = await conn.send('Extensions.loadUnpacked', { path: arg });
      console.log('LOADED', JSON.stringify(r));
    } catch (e) {
      console.log('LOAD-FAILED', e.message);
    }
    conn.close();
  } else if (cmd === 'ext-eval') {
    // Evaluate an expression inside the extension service worker.
    const targets = await http('/json/list');
    const sw = targets.find((t) => t.type === 'service_worker' && t.url === `chrome-extension://${EXT_ID}/background.js`);
    if (!sw) { console.log('SW-NOT-FOUND'); for (const t of targets) console.log(`  ${t.type}  ${t.url}`); process.exit(1); }
    const conn = await Conn.connect(sw.webSocketDebuggerUrl);
    console.log(JSON.stringify(await conn.evaluate(arg), null, 2));
    conn.close();
  } else if (cmd === 'page-eval') {
    const arg2 = process.argv[4] || '';
    const targets = await http('/json/list');
    let t = targets.find((t) => t.url === arg);
    if (!t) t = targets.find((t) => t.url.includes(arg));
    if (!t || t.type !== 'page') { console.log('PAGE-NOT-FOUND'); for (const x of targets) console.log(`  ${x.type}  ${x.url}`); process.exit(1); }
    const conn = await Conn.connect(t.webSocketDebuggerUrl);
    console.log(JSON.stringify(await conn.evaluate(arg2), null, 2));
    conn.close();
  } else if (cmd === 'nav') {
    const targets = await http('/json/list');
    let t = targets.find((x) => x.type === 'page' && (x.url === arg || x.url.includes(arg)));
    if (!t) { console.log('PAGE-NOT-FOUND'); process.exit(1); }
    const url = process.argv[4] || '';
    const conn = await Conn.connect(t.webSocketDebuggerUrl);
    console.log(JSON.stringify(await conn.send('Page.navigate', { url })), null, 2);
    conn.close();
  } else if (cmd === 'sw-eval') {
    // Evaluate inside the Neelima background service worker.
    const arg2 = process.argv[4] || '';
    const targets = await http('/json/list');
    const sw = targets.find((x) => x.type === 'service_worker' && x.url === `chrome-extension://${EXT_ID}/background.js`);
    if (!sw) { console.log('SW-NOT-FOUND'); for (const x of targets) if (x.type === 'service_worker') console.log(`  ${x.url}`); process.exit(1); }
    const conn = await Conn.connect(sw.webSocketDebuggerUrl);
    console.log(JSON.stringify(await conn.evaluate(arg2), null, 2));
    conn.close();
  } else if (cmd === 'click-loadunpacked') {
    const targets = await http('/json/list');
    const t = targets.find((x) => x.type === 'page' && x.url === 'chrome://extensions/');
    if (!t) { console.log('EXT-PAGE-MISSING'); process.exit(1); }
    const conn = await Conn.connect(t.webSocketDebuggerUrl);
    await conn.send('Runtime.enable');
    const box = await conn.evaluate(`(() => { const btn = document.querySelector('extensions-manager').shadowRoot.querySelector('extensions-toolbar').shadowRoot.querySelector('#loadUnpacked'); if (!btn) return null; const r = btn.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!box) { console.log('BTN-MISSING'); process.exit(1); }
    await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    console.log('CLICKED-TRUSTED', JSON.stringify(box));
    conn.close();
  } else if (cmd === 'new-tab') {
    const t = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(arg)}`, { method: 'PUT' })).json();
    console.log(JSON.stringify({ id: t.id, url: t.url, ws: t.webSocketDebuggerUrl }));
  }
}
main().catch((e) => { console.error('DRIVER-ERROR', e.message); process.exit(1); });
