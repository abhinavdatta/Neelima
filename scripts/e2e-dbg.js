'use strict';
const url = process.argv[2];
(async () => {
  const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  let t = targets.find(x => x.url === url) || targets.find(x => x.url.includes(url));
  if (!t) { console.log('NO-TARGET'); process.exit(1); }
  console.log('attach', t.url);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  const done = (why) => { if (!done.f) { done.f = 1; console.log('CLOSE', why); process.exit(0); } };
  ws.onopen = () => {
    console.log('ws-open');
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
    ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: '1+1', returnByValue: true } }));
  };
  ws.onclose = (ev) => done(`code=${ev.code} reason=${ev.reason} clean=${ev.wasClean}`);
  ws.onerror = () => console.log('ws-error-event');
  ws.onmessage = (ev) => console.log('msg:', ev.data.slice(0, 400));
  setTimeout(() => { console.log('no-close-in-6s'); }, 6000);
  setTimeout(() => process.exit(2), 7000);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
