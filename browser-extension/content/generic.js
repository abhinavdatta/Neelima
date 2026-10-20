(() => {
  'use strict';
  const SITE_ID = "generic";
  const SELECTORS = ["[data-neelima-assistant-message=\"true\"]", "[data-message-author-role=\"assistant\"]", "[role=\"article\"]"];
  const guardKey = `__NEELIMA_ADAPTER_LOADED_${SITE_ID}__`;
  if (window[guardKey]) return;
  window[guardKey] = true;
  const BUTTON_ATTR = 'data-neelima-review-button';
  const PANEL_ATTR = 'data-neelima-review-panel';

  function candidate(text) {
    const fenced = text.match(/```neelima-tool\s*\n([\s\S]*?)\n```/i);
    const tagged = text.match(/<neelima-tool-call>\s*([\s\S]*?)\s*<\/neelima-tool-call>/i);
    return fenced?.[1] || tagged?.[1] || null;
  }
  function showPanel(message, text) {
    message.querySelector(`[${PANEL_ATTR}]`)?.remove();
    const panel = document.createElement('div');
    panel.setAttribute(PANEL_ATTR, 'true');
    panel.setAttribute('role', 'status');
    panel.style.cssText = 'margin:8px 4px;padding:9px 11px;border:1px solid #777;border-radius:8px;background:#f5f5f5;color:#161616;font:12px/1.5 system-ui;white-space:normal;';
    panel.textContent = text;
    message.appendChild(panel);
  }
  function addButton(message) {
    if (message.querySelector(`[${BUTTON_ATTR}]`)) return;
    const raw = message.textContent || '';
    if (!candidate(raw)) return;
    const button = document.createElement('button');
    button.setAttribute(BUTTON_ATTR, 'true');
    button.type = 'button';
    button.textContent = 'Review in Neelima';
    button.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin:8px 4px;padding:7px 11px;border:1px solid #8a8a8a;border-radius:8px;background:#202124;color:#fff;font:600 12px system-ui;cursor:pointer;z-index:2147483647;';
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = 'Sending to Neelima…';
      try {
        let payload;
        try { payload = JSON.parse(candidate(raw)); } catch (_) { throw new Error('The Neelima tool block contains invalid JSON.'); }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('The tool request must be a JSON object.');
        payload = { ...payload, site: SITE_ID, page_origin: location.origin, user_activated: true };
        const response = await chrome.runtime.sendMessage({ type: 'NEELIMA_PROPOSE_TOOL', proposal: payload });
        if (!response?.ok) throw new Error(response?.error || 'Neelima did not accept the request.');
        button.textContent = response.status === 'awaiting_approval' ? 'Waiting for approval in Neelima' : 'Request sent to Neelima';
        showPanel(message, `Neelima status: ${response.status || 'accepted'}. ${response.message || 'Complete any required approval in the desktop app.'}`);
      } catch (error) {
        button.disabled = false;
        button.textContent = 'Review in Neelima';
        showPanel(message, error instanceof Error ? error.message : 'Could not send request to Neelima.');
      }
    });
    message.appendChild(button);
  }
  function scan() {
    if (document.visibilityState === 'hidden') return;
    for (const selector of SELECTORS) document.querySelectorAll(selector).forEach(addButton);
  }
  scan();
  const observer = new MutationObserver(scan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', scan);
})();
