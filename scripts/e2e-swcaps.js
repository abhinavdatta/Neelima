'use strict';
(async () => {
  const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const t = targets.find(x => x.type === 'service_worker' && x.url.includes('gcjjbofmdcdfdofapeefmdgkldpibokp'));
  if (!t) { console.log('SW-NOT-FOUND'); process.exit(1); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  ws.onopen = () => {
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
    ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: {
      expression: `(async () => { return await new Promise((resolve) => { let msg = null; const p = chrome.runtime.connectNative('com.neelima.browser_bridge'); const id = Math.random().toString(36).slice(2); const dv = setTimeout(() => { try { p.disconnect(); } catch (_) {} resolve({ error: 'TIMEOUT', lastMsg: msg }); }, 6000); p.onMessage.addListener((m) => { clearTimeout(dv); try { p.disconnect(); } catch (_) {} resolve(m); }); p.onDisconnect.addListener(() => { clearTimeout(dv); resolve({ lastMsg: msg, lastError: (chrome.runtime.lastError && chrome.runtime.lastError.message) || null }); }); p.postMessage({ version: 1, request_id: id, operation: 'bridge.capabilities' }); }); })()`,
      awaitPromise: true, returnByValue: true
    }}));
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id !== 2) return;
    const v = m.result.result.value;
    const r = v.result || {};
    const out = {
      status: v.status,
      protocol_version: r.protocol_version,
      operations: r.operations,
      approval_required_for: r.approval_required_for,
      policy: r.approval_policy,
      idempotency: r.idempotency,
      max_propose_bytes: r.max_propose_bytes,
      approval_timeout_secs: r.approval_timeout_secs,
      tools: (r.tool_schemas || []).map((t) => {
        const args = (t.args || []).map((a) => {
          const req = a.required ? '!' : '?';
          const cap = (a.kind === 'string' && a.max_bytes) ? `(max_bytes=${a.max_bytes})` : '';
          return a.name + req + cap;
        });
        return { name: t.name, risk: t.risk, category: t.category, bridge_allowed: t.bridge_allowed, unknown_args: t.unknown_args, args };
      })
    };
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  };
  setTimeout(() => { console.log('TIMEOUT'); process.exit(0); }, 7500);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
