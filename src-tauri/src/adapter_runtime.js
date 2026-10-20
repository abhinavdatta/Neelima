// Neelima adapter runtime — injected into the provider webview via
// WebviewBuilder::initialization_script, AFTER the adapter config is embedded:
//   window.__LB_ADAPTER__ = {json};
//
// Contract with Rust (the ONLY reachable command is lb_bridge):
//   Rust evals:  window.__LB__.call(method, argJson, reqId, nonce)
//   The runtime executes the method, then posts {t:"rpc_result", id, nonce, v}
//   where v is JSON: {ok:true,value} | {ok:false,error}.
//
// PUSH events (no polling anywhere): after load the page posts
//   {t:"ready"}                                   — page finished booting
//   {t:"login_state", state, url, reason}         — on load, SPA navigation
//                                                    (history patched) and on
//                                                    debounced DOM changes
//   {t:"assistant_message", seq, text, nonce}     — when a reply completes
//
// SECURITY: the page may NEVER read or write files — the old file_op /
// read_file / write_file / list_dir paths were removed. Every message is
// mount-nonce bound, and Rust also checks the current webview origin (B2).

(function () {
  if (window.__LB__) return;
  var A = window.__LB_ADAPTER__ || {};
  var S = A.selectors || {};
  var LOGIN_PATTERNS = A.login_url_patterns || [];

  // The injected script provides a per-mount nonce; Rust checks it together
  // with the webview's current origin for every bridge message (B2).
  function currentNonce() { return window.__LB_NONCE__ || ""; }

  function hasIpc() {
    return !!(window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === "function");
  }
  function post(obj) {
    if (!hasIpc()) return Promise.reject(new Error("no ipc"));
    try { return window.__TAURI_INTERNALS__.invoke("lb_bridge", { msg: JSON.stringify(obj) }); }
    catch (e) { return Promise.reject(e); }
  }
  function reply(id, value, error) {
    if (!id) return; // fire-and-forget evals carry no id
    var v = JSON.stringify(error ? { ok: false, error: String((error && error.message) || error) } : { ok: true, value: value === undefined ? null : value });
    post({ t: "rpc_result", id: id, nonce: currentNonce(), v: v });
  }
  function parseArg(a) { return typeof a === "string" ? JSON.parse(a) : (a || {}); }
  function q(sel) { try { return document.querySelector(sel); } catch (e) { return null; } }
  function visible(el) {
    return !!(el && (el.getClientRects().length > 0 || el === document.activeElement));
  }

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

  // ---- login detection (A5, per-adapter) ------------------------------------
  // Logged in = composer visible AND no login/signup marker AND the URL is
  // not on a login/auth path. The naive "composer AND send button" check
  // never fires on sites that hide/swap the send button while the composer is
  // empty.
  function onLoginPage() {
    var href = location.href || "";
    for (var i = 0; i < LOGIN_PATTERNS.length; i++) {
      try { if (href.indexOf(LOGIN_PATTERNS[i]) !== -1) return true; } catch (e) {}
    }
    return false;
  }
  function evalLogin() {
    if (onLoginPage()) {
      return { state: "logged_out", reason: "on a login/auth page" };
    }
    var composer = S.input ? q(S.input) : null;
    var composerVisible = visible(composer);
    if (composerVisible) {
      if (S.logged_out && visible(q(S.logged_out))) {
        return { state: "logged_out", reason: "logged-out marker visible" };
      }
      return { state: "logged_in", reason: "composer visible" };
    }
    var out = S.logged_out ? q(S.logged_out) : null;
    if (visible(out)) {
      return { state: "logged_out", reason: "logged-out marker visible, composer absent" };
    }
    return { state: "unknown", reason: "composer not found yet" };
  }

  // SPA navigation: patch pushState/replaceState, listen to popstate.
  (function patchHistory() {
    function fire() { scheduleLoginReport(50); }
    try {
      var ps = history.pushState, rs = history.replaceState;
      if (ps) history.pushState = function () { var r = ps.apply(this, arguments); fire(); return r; };
      if (rs) history.replaceState = function () { var r = rs.apply(this, arguments); fire(); return r; };
      window.addEventListener("popstate", fire);
      window.addEventListener("hashchange", fire);
    } catch (e) {}
  })();

  var lastReported = "";
  function reportLogin() {
    var r = evalLogin();
    var key = r.state + "|" + location.href;
    if (key === lastReported) return r;
    lastReported = key;
    post({ t: "login_state", state: r.state, url: location.href, reason: r.reason, nonce: currentNonce() }).catch(function () {});
    return r;
  }
  var loginTimer = null;
  function scheduleLoginReport(delay) {
    if (loginTimer) clearTimeout(loginTimer);
    loginTimer = setTimeout(reportLogin, delay || 500);
  }

  // Debounced MutationObserver: page mutations re-evaluate login state.
  (function observeDom() {
    var obs = new MutationObserver(function () { scheduleLoginReport(700); });
    function start() {
      if (document.body) { obs.observe(document.body, { childList: true, subtree: true }); }
      else { setTimeout(start, 200); }
    }
    start();
  })();

  // Boot: post ready + first login state after the page is usable.
  function boot() {
    post({ t: "ready", url: location.href, has_ipc: hasIpc(), nonce: currentNonce() }).catch(function () {});
    lastReported = "";
    reportLogin();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
    window.addEventListener("load", boot);
    // SPA bootstraps often re-render late; make sure we do not miss it.
    setTimeout(function () { if (!document.querySelector(S.input)) { scheduleLoginReport(2500); } }, 3000);
  } else {
    setTimeout(boot, 0);
  }

  // ---- completion detection + assistant_message push (A9) -------------------
  var ASSIST_SEQ = 0;

  function stableContainer() {
    // Observe the nearest STABLE container (main or body), NOT the first
    // message node — sites move message nodes around mid-stream.
    var m = S.messages ? q(S.messages) : null;
    if (m) {
      var up = m.closest("main") || m.closest("body");
      if (up) return up;
    }
    return document.querySelector("main") || document.body;
  }

  function extractedLast() {
    var nodes = document.querySelectorAll(S.messages);
    if (!nodes.length) return { count: 0, text: "" };
    var last = nodes[nodes.length - 1];
    var candidates = last.querySelectorAll("[data-message-author-role], .assistant, .agent-turn, [class*=assistant]");
    var target = candidates.length ? candidates[candidates.length - 1] : last;
    return { count: nodes.length, text: (target.innerText || target.textContent || "").trim() };
  }

  function stopVisible() {
    if (!S.stop_button) return false;
    var stop = q(S.stop_button);
    return !!(stop && stop.offsetParent !== null);
  }

  function waitResponse(arg) {
    var cfg = parseArg(arg);
    var quiet = cfg.quiet_ms || A.quiet_ms || 2000;
    var deadlineMs = cfg.timeout_ms || A.response_timeout_ms || 300000;
    return new Promise(function (resolve) {
      var container = stableContainer();
      var obs = null, quietTimer = null, startTimer = null, deadlineTimer = null;
      var startedAt = Date.now();
      var phase = "waiting_start"; // waiting_start -> generating -> done
      var baseline = extractedLast();
      var baselineCount = baseline.count;
      var baselineText = baseline.text;

      function finish(v) {
        if (obs) obs.disconnect();
        if (quietTimer) clearTimeout(quietTimer);
        if (startTimer) clearTimeout(startTimer);
        if (deadlineTimer) clearTimeout(deadlineTimer);
        resolve(v);
      }

      function reportPush(text) {
        ASSIST_SEQ += 1;
        post({ t: "assistant_message", seq: ASSIST_SEQ, text: text, nonce: currentNonce() }).catch(function () {});
      }

      function checkStart() {
        var cur = extractedLast();
        var genStarted = stopVisible() || cur.count > baselineCount || cur.text !== baselineText;
        if (genStarted) {
          phase = "generating";
          if (startTimer) clearTimeout(startTimer);
          armQuiet();
        }
      }

      function armQuiet() {
        if (quietTimer) clearTimeout(quietTimer);
        if (stopVisible()) return;
        quietTimer = setTimeout(function () {
          if (stopVisible()) return; // completion will be reconsidered on DOM mutation
          var cur = extractedLast();
          if (!cur.text) { finish({ error: "reply detected but text extraction failed" }); return; }
          reportPush(cur.text);
          finish({ complete: true, elapsed: Date.now() - startedAt });
        }, quiet);
      }

      obs = new MutationObserver(function () {
        if (phase === "waiting_start") checkStart();
        else armQuiet();
      });
      obs.observe(container, { childList: true, subtree: true, characterData: true });

      // Start watchdog and overall deadline are one-shot timers; DOM changes,
      // not polling, detect the transition into and out of generation.
      startTimer = setTimeout(function () {
        if (phase === "waiting_start") {
          var cur = extractedLast();
          if (stopVisible() || cur.count > baselineCount || cur.text !== baselineText) {
            phase = "generating";
            armQuiet();
            return;
          }
          finish({ error: "generation did not start within 60s (message may not have been sent)" });
        }
      }, 60000);
      deadlineTimer = setTimeout(function () {
        finish({ error: "response timeout" });
      }, deadlineMs);
    });
  }

  // ---- extraction -----------------------------------------------------------
  function stripUiNoise(text) {
    if (!text) return "";
    return text
      .split("\n")
      .filter(function (line) { return !/^\s*(copy|copy code|copied!?)\s*$/i.test(line); })
      .join("\n")
      .replace(/【[^】]{0,64}】/g, "") // citation tokens
      .trim();
  }
  function getLastAssistant() {
    var nodes = document.querySelectorAll(S.messages);
    var last = nodes.length ? nodes[nodes.length - 1] : null;
    if (!last) return "";
    var candidates = last.querySelectorAll("[data-message-author-role], .assistant, .agent-turn, [class*=assistant]");
    var target = candidates.length ? candidates[candidates.length - 1] : last;
    return stripUiNoise(target.innerText || target.textContent || "");
  }

  // ---- actions ---------------------------------------------------------------
  var IMPL = {
    ping: function () { return "pong:" + location.host; },
    page_info: function () {
      var r = evalLogin();
      function found(selector) {
        try { return !!(selector && document.querySelector(selector)); } catch (e) { return false; }
      }
      var messages = false;
      try { messages = !!(S.messages && document.querySelector(S.messages)); } catch (e) {}
      return {
        url: location.href,
        logged_in: r.state === "logged_in",
        login: r,
        input_found: found(S.input),
        send_button_found: found(S.send_button),
        messages_found: messages
      };
    },
    is_logged_in: function () { return evalLogin().state === "logged_in"; },

    new_chat: function () {
      var btn = S.new_chat ? q(S.new_chat) : null;
      if (btn) { btn.click(); return { clicked: true }; }
      return { clicked: false };
    },

    send_message: function (a) {
      var cfg = parseArg(a);
      var input = S.input ? q(S.input) : null;
      if (!input) return { error_type: "page_changed", error: "input not found: " + S.input };
      setEditorText(input, String(cfg.text || ""), A.input && A.input.kind);
      // Give the site a beat to enable its send button, human-paced.
      return new Promise(function (resolve) {
        // Capture assistant-message count/text and begin observing BEFORE the
        // send action can cause the first response mutation.
        waitResponse(cfg).catch(function (e) {
          if (window.console && console.warn) console.warn("[neelima] wait_response error", e);
        });
        setTimeout(function () {
          var send = S.send_button ? q(S.send_button) : null;
          if (!send || send.disabled) {
            // Some sites enable via Enter
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
            input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
            // Kick wait_response ourselves: the reply watcher lives per send.
          } else {
            send.click();
          }
          resolve({ sent: true });
        }, 250);
      });
    },

    wait_response: function (a) { return waitResponse(a); },
    get_last_assistant: function () { return getLastAssistant(); },

    // Adapter Inspector: report a robust selector for the clicked element.
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
    call: function (method, arg, id, nonce) {
      // B2: every Rust-side eval carries the per-mount nonce; remember the
      // latest so pushes and rpc_results stay authenticated.
      if (nonce) window.__LB_NONCE__ = nonce;
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
})();
