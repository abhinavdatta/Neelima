(() => {
  'use strict';
  // Result return path: Neelima executed an approved tool and the backend
  // returned the REAL result. Nothing is inserted into the page without an
  // explicit user click — the relay only shows a review panel with the status
  // and an arm button that fills the composer with a ```result block.
  if (window.__NEELIMA_RESULT_RELAY__) return;
  window.__NEELIMA_RESULT_RELAY__ = true;
  const PANEL_ATTR = 'data-neelima-result-panel';

  function findComposer() {
    return (
      document.querySelector('div[contenteditable="true"]#prompt-textarea') ||
      document.querySelector('[data-testid="prompt-textarea"]') ||
      document.querySelector('div[contenteditable="true"][role="textbox"]') ||
      document.querySelector('textarea')
    );
  }

  function insertResultBlock(text) {
    const composer = findComposer();
    if (!composer) return false;
    composer.focus();
    const block = '```result\n' + text + '\n```';
    if (composer.isContentEditable) {
      document.execCommand('insertText', false, block);
    } else if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {
      const proto = composer.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      desc.set.call(composer, block);
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  }

  function showResultPanel(status, summary, resultText) {
    document.querySelectorAll(`[${PANEL_ATTR}]`).forEach((el) => el.remove());
    const panel = document.createElement('div');
    panel.setAttribute(PANEL_ATTR, 'true');
    panel.setAttribute('role', 'status');
    panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:420px;padding:12px 14px;border:1px solid #777;border-radius:10px;background:#1e1f24;color:#eee;font:12px/1.5 system-ui;box-shadow:0 8px 28px rgba(0,0,0,.4);';
    const head = document.createElement('div');
    head.textContent = `Neelima result — ${status}`;
    head.style.cssText = 'font-weight:600;margin-bottom:6px;';
    const body = document.createElement('div');
    body.textContent = summary;
    body.style.cssText = 'margin-bottom:8px;white-space:pre-wrap;max-height:120px;overflow:auto;';
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;';
    const arm = document.createElement('button');
    arm.type = 'button';
    arm.textContent = 'Insert result into composer';
    arm.style.cssText = 'padding:6px 10px;border:1px solid #888;border-radius:6px;background:#e8e8e8;color:#111;font:600 12px system-ui;cursor:pointer;';
    arm.addEventListener('click', () => {
      const ok = insertResultBlock(resultText);
      arm.textContent = ok ? 'Inserted — review before sending' : 'Composer not found';
      arm.disabled = true;
    });
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = 'Dismiss';
    dismiss.style.cssText = 'padding:6px 10px;border:1px solid #666;border-radius:6px;background:transparent;color:#bbb;font:12px system-ui;cursor:pointer;';
    dismiss.addEventListener('click', () => panel.remove());
    actions.append(arm, dismiss);
    panel.append(head, body, actions);
    document.body.appendChild(panel);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== 'NEELIMA_RESULT') return;
    // The backend result arrives truncated (4 KiB cap) and metadata-first;
    // file contents stay inside Neelima unless the user explicitly inserts
    // and sends the block themselves.
    const status = typeof message.status === 'string' ? message.status : 'unknown';
    const summary = typeof message.summary === 'string' ? message.summary : 'Operation finished in Neelima.';
    const resultText = typeof message.result_text === 'string' ? message.result_text : '';
    showResultPanel(status, summary, resultText);
  });
})();
