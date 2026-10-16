// Neelima adapter runtime — injected into the provider webview via
// WebviewBuilder::initialization_script, AFTER the adapter config is embedded:
//   window.__LB_ADAPTER__ = {json};
//
// Contract with Rust (the ONLY reachable command is lb_bridge):
//   Rust evals:  window.__LB__.call(method, argJson, reqId)
//   The runtime executes the method, then posts {t:"rpc_result", id, v} where
//   v is JSON: {ok:true,value} | {ok:false,error}.
//
// No polling loops: response completion = MutationObserver on the messages
// container + quiet-period timer re-armed by mutations, plus a stop-button
// check with bounded rechecks. Never reads cookies, tokens, or credentials —
// only the assistant message text and the input element the user types into.

(function () {
  if (window.__LB__) return;
  var A = window.__LB_ADAPTER__ || {};
  var S = A.selectors || {};

  function hasIpc() {
    return !!(window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === "function");
  }
  function post(obj) {
    if (!hasIpc()) return Promise.reject(new Error("no ipc"));
    try { return window.__TAURI_INTERNALS__.invoke("lb_bridge", { msg: JSON.stringify(obj) }); }
    catch (e) { return Promise.reject(e); }
  }
  function reply(id, value, error) {
    var v = JSON.stringify(error ? { ok: false, error: String(error && error.message || error) } : { ok: true, value: value === undefined ? null : value });
    post({ t: "rpc_result", id: id, v: v });
  }
  function parseArg(a) { return typeof a === "string" ? JSON.parse(a) : (a || {}); }
  function q(sel) { try { return document.querySelector(sel); } catch (e) { return null; } }

  // ---- input setting -------------------------------------------------------
  function setNativeValue(el, value) {
    var proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, "value");
    desc.set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function setEditorText(el, text, kind) {
    el.focus();
    if (kind === "textarea" || el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      setNativeValue(el, text);
      return;
    }
    // contenteditable: select-all + insertText fires real InputEvents that
    // ProseMirror/Slate/React editors listen to.
    var sel = window.getSelection();
    var range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    var max = (A.input && A.input.max_chars) || 0;
    if (max && text.length > max) {
      // Chunked insert: keeps a single message, inserts in slices (paste-style).
      document.execCommand("delete");
      for (var i = 0; i < text.length; i += max) {
        document.execCommand("insertText", false, text.slice(i, i + max));
      }
    } else {
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, text);
    }
  }

  // ---- completion detection (event-driven) ---------------------------------
  function waitResponse(arg) {
    var cfg = parseArg(arg);
    var quiet = cfg.quiet_ms || A.quiet_ms || 2000;
    var deadlineMs = cfg.timeout_ms || A.response_timeout_ms || 300000;
    return new Promise(function (resolve) {
      var container = q(S.messages);
      if (!container) { resolve({ error: "messages container not found: " + S.messages }); return; }
      var obs = null, timer = null, rechecks = 0;
      var startedAt = Date.now();
      function finish(v) {
        if (obs) obs.disconnect();
        if (timer) clearTimeout(timer);
        resolve(v);
      }
      function arm() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () {
          if (S.stop_button) {
            var stop = q(S.stop_button);
            var visible = stop && stop.offsetParent !== null;
            if (visible && rechecks < 3) { rechecks++; arm(); return; }
          }
          finish({ complete: true, rechecks: rechecks, elapsed: Date.now() - startedAt });
        }, quiet);
      }
      obs = new MutationObserver(function () {
        if (Date.now() - startedAt > deadlineMs) { finish({ error: "response timeout" }); return; }
        arm();
      });
      obs.observe(container, { childList: true, subtree: true, characterData: true });
      // Safety net if the page NEVER mutates (bounded, not a poll loop).
      timer = setTimeout(function () { finish({ complete: true, note: "no-mutations-quiet" }); }, quiet);
    });
  }

  // ---- extraction -----------------------------------------------------------
  function stripUiNoise(text) {
    if (!text) return "";
    return text
      .split("\n")
      .filter(function (line) { return !/^\s*(copy|copy code|copied!?)\s*$/i.test(line); })
      .join("\n")
      .replace(/\u3010[^\u3011]{0,64}\u3011/g, "") // citation tokens
      .trim();
  }
  function getLastAssistant() {
    var nodes = document.querySelectorAll(S.messages);
    var last = nodes.length ? nodes[nodes.length - 1] : null;
    if (!last) return "";
    // Prefer the site's own last message element if the container holds several.
    var candidates = last.querySelectorAll("[data-message-author-role], .assistant, .agent-turn, [class*=assistant]");
    var target = candidates.length ? candidates[candidates.length - 1] : last;
    var text = target.innerText || target.textContent || "";
    return stripUiNoise(text);
  }

  // ---- actions ---------------------------------------------------------------
  function isLoggedIn() {
    if (S.logged_in) return !!q(S.logged_in);
    return !!(q(S.input) && q(S.send_button));
  }

  var IMPL = {
    ping: function () { return "pong:" + location.host; },
    page_info: function () { return { url: location.href, logged_in: isLoggedIn() }; },
    is_logged_in: function () { return isLoggedIn(); },

    new_chat: function () {
      var btn = S.new_chat && q(S.new_chat);
      if (btn) { btn.click(); return { clicked: true }; }
      return { clicked: false };
    },

    send_message: function (a) {
      var cfg = parseArg(a);
      var input = q(S.input);
      var send = q(S.send_button);
      if (!input) return { error: "input not found: " + S.input };
      if (!send) return { error: "send button not found: " + S.send_button };
      setEditorText(input, String(cfg.text || ""), A.input && A.input.kind);
      // Give the site a beat to enable its send button, human-paced.
      return new Promise(function (resolve) {
        setTimeout(function () {
          var send2 = q(S.send_button);
          if (!send2 || send2.disabled) {
            // Some sites enable via Enter
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
            input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
          } else {
            send2.click();
          }
          resolve({ sent: true });
        }, 250);
      });
    },

    wait_response: function (a) { return waitResponse(a); },
    get_last_assistant: function () { return getLastAssistant(); },

    // Adapter Inspector: report a robust selector for the clicked element.
    // ---- file I/O (scoped to current workspace) ----
    file_op: async function (a) {
      var op = parseArg(a);
      var msg = { t: "file_op", id: "r" + Date.now().toString(36) + Math.random().toString(36).slice(2), v: JSON.stringify(op) };
      return await post(msg);
    },
    read_file: async function (a) {
      var cfg = parseArg(a);
      return await post({ t: "file_op", id: "r" + Date.now().toString(36), v: JSON.stringify({ op: "read_file", args: { path: cfg.path, offset: cfg.offset, limit: cfg.limit } }) });
    },
    write_file: async function (a) {
      var cfg = parseArg(a);
      return await post({ t: "file_op", id: "r" + Date.now().toString(36), v: JSON.stringify({ op: "write_file", args: { path: cfg.path, content: cfg.content, append: cfg.append } }) });
    },
    list_dir: async function (a) {
      var cfg = parseArg(a);
      return await post({ t: "file_op", id: "r" + Date.now().toString(36), v: JSON.stringify({ op: "list_dir", args: { path: cfg.path || "." } }) });
    },

    inspector_start: function () {
      function robustSelector(el) {
        if (el.id) return "#" + CSS.escape(el.id);
        var testid = el.getAttribute && (el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("aria-label"));
        if (testid) return "[data-testid=\"" + testid + "\"],[aria-label=\"" + testid + "\"]";
        var parts = [];
        var node = el;
        while (node && node !== document.body && parts.length < 5) {
          var part = node.tagName ? node.tagName.toLowerCase() : "";
          if (node.parentElement) {
            var sibs = Array.prototype.filter.call(node.parentElement.children, function (c) { return c.tagName === node.tagName; });
            if (sibs.length > 1) part += ":nth-of-type(" + (Array.prototype.indexOf.call(sibs, node) + 1) + ")";
          }
          parts.unshift(part);
          node = node.parentElement;
        }
        return parts.join(" > ");
      }
      window.__LB_INSPECTOR__ = function (e) {
        e.preventDefault(); e.stopPropagation();
        var kind = window.__LB_INSPECTOR_KIND__;
        var sel = robustSelector(e.target);
        reply(window.__LB_INSPECTOR_REQ__, { kind: kind, selector: sel, tag: e.target.tagName });
        document.removeEventListener("click", window.__LB_INSPECTOR__, true);
        document.body.style.cursor = "";
      };
      window.__LB_INSPECTOR_KIND__ = arguments[0] && parseArg(arguments[0]).kind;
      window.__LB_INSPECTOR_REQ__ = arguments[1];
      document.addEventListener("click", window.__LB_INSPECTOR__, true);
      document.body.style.cursor = "crosshair";
      return { armed: true };
    },
  };

  window.__LB__ = {
    call: function (method, arg, id) {
      var fn = IMPL[method];
      if (!fn) { reply(id, null, "no-such-method:" + method); return; }
      try {
        var v = fn(arg);
        if (v && typeof v.then === "function") {
          v.then(function (r) { reply(id, r); }, function (e) { reply(id, null, e); });
        } else { reply(id, v); }
      } catch (e) { reply(id, null, e); }
    },
    has_ipc: hasIpc(),
  };

  post({ t: "hello", url: location.href, has_ipc: hasIpc() });
})();
