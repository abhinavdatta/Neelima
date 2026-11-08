'use strict';
(async () => {
  const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const t = targets.find(x => x.type === 'page' && x.url.startsWith('https://chatgpt.com'));
  if (!t) { console.log('CHATGPT-TAB-MISSING'); process.exit(1); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.send(JSON.stringify({ id: 1, method: 'Target.activateTarget', params: { targetId: t.id } }));
  await new Promise((res) => setTimeout(res, 800));
  console.log('ACTIVATED', t.id);
  ws.close();
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
