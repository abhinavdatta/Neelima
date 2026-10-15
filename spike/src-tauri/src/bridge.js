// LocalBridge spike — injected into every page of every webview via
// WebviewBuilder::initialization_script. Runs before page scripts on every navigation.
//
// Design notes:
//  - The ONLY Rust command this script ever calls is `lb_bridge`, a small typed
//    intake channel granted to provider webviews via a capability that contains
//    nothing else. The full Tauri API surface is never exposed to provider pages.
//  - No polling: page->Rust is a single invoke; Rust->page is eval; long-running
//    waits (response completion) use MutationObserver + a quiet-period timer that
//    is re-armed by mutations, never a setInterval loop.
//  - Never reads cookies, storage keys other than the synthetic spike marker, or
//    any credential material.
(function () {
  if (window.__LB_SPIKE__) return;
  var hasIpc = !!(window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === "function");

  function post(obj) {
    if (!hasIpc) { window.__LB_SPIKE_NOIPC__ = (window.__LB_SPIKE_NOIPC__ || 0) + 1; return false; }
    try {
      window.__TAURI_INTERNALS__.invoke("lb_bridge", { msg: JSON.stringify(obj) }).catch(function () {});
      return true;
    } catch (e) { window.__LB_SPIKE_POSTERR__ = String(e); return false; }
  }

  function reply(id, value, error) {
    var v = JSON.stringify(error ? { ok: false, error: String(error && error.message || error) } : { ok: true, value: value === undefined ? null : value });
    post({ t: "rpc_result", id: id, v: v });
  }

  function parseArg(a) { return typeof a === "string" ? JSON.parse(a) : (a || {}); }

  var IMPL = {
    ping: function () { return "pong:" + location.host; },

    page_info: function () {
      return { url: location.href, has_ipc: hasIpc, has_global_tauri: !!window.__TAURI__ };
    },

    // --- storage persistence probe (synthetic marker only; never credentials) ---
    set_marker: function (v) {
      try {
        // Rust passes the value JSON-encoded; strip the surrounding quotes.
        var val = typeof v === "string" ? v.replace(/^"(.*)"$/, "$1") : String(v);
        localStorage.setItem("__lb_spike_marker__", val);
        return "set:" + val;
      } catch (e) { return "err:" + String(e); }
    },
    get_marker: function () {
      try { return localStorage.getItem("__lb_spike_marker__") || ""; } catch (e) { return "err:" + String(e); }
    },

    // --- capability probes -------------------------------------------------
    // spike_action is NOT granted to provider webviews. If this ever resolves
    // with "reached", the ACL failed and the report marks the test FAIL.
    probe_forbidden: function () {
      if (!hasIpc) return "no-ipc";
      return window.__TAURI_INTERNALS__.invoke("spike_action", { action: "probe_forbidden", arg: "probe" })
        .then(function (r) { return "LEAK-spike-action-reached-rust:" + JSON.stringify(r); })
        .catch(function (e) { return "blocked-as-expected: " + String(e).slice(0, 200); });
    },
    // Positive control: from the ui webview spike_action must be allowed.
    probe_allowed: function () {
      if (!hasIpc) return "no-ipc";
      return window.__TAURI_INTERNALS__.invoke("spike_action", { action: "echo", arg: "hi" })
        .then(function (r) { return "allowed: " + JSON.stringify(r); })
        .catch(function (e) { return "unexpectedly-blocked: " + String(e).slice(0, 200); });
    },

    // --- DOM automation (demo-chat page) ------------------------------------
    // Strategies a real adapter would choose per provider:
    //   textarea      -> native value setter + input event (React-style controlled input)
    //   contenteditable -> selectAll + execCommand insertText (fires real InputEvents)
    demo_send: function (a) {
      var arg = parseArg(a);
      var ce = document.querySelector("#ce"), ta = document.querySelector("#ta"), send = document.querySelector("#send");
      if (!ce || !ta || !send) return { error: "missing-elements" };
      if (arg.strategy === "textarea") {
        ta.focus();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, arg.text);
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        ce.focus();
        var sel = window.getSelection();
        var range = document.createRange();
        range.selectNodeContents(ce);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand("insertText", false, arg.text);
        ce.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: arg.text }));
      }
      send.click();
      return { clicked: true, strategy: arg.strategy };
    },

    // Response-complete detection WITHOUT setInterval: a MutationObserver on the
    // message container re-arms a quiet-period timer; completion = stop button
    // gone + quiet period elapsed. Bounded rechecks (3) only if the stop button
    // is still visible while no mutations arrive.
    demo_wait_response: function (a) {
      var arg = parseArg(a);
      var quiet = arg.quiet_ms || 700;
      return new Promise(function (resolve) {
        var msgs = document.querySelector("#messages");
        if (!msgs) { resolve({ error: "no-messages-container" }); return; }
        var timer = null, checks = 0, obs = null;
        var finish = function (v) {
          if (obs) obs.disconnect();
          if (timer) clearTimeout(timer);
          resolve(v || { complete: true });
        };
        var arm = function () {
          if (timer) clearTimeout(timer);
          timer = setTimeout(function () {
            var stop = document.querySelector("#stop");
            var visible = stop && stop.style.display !== "none";
            if (visible && checks < 3) { checks++; arm(); return; }
            finish({ complete: true, rechecks: checks });
          }, quiet);
        };
        obs = new MutationObserver(function () { arm(); });
        obs.observe(msgs, { childList: true, subtree: true, characterData: true });
        arm();
      });
    },

    demo_get_last_assistant: function () {
      var els = document.querySelectorAll(".msg.assistant");
      return els.length ? els[els.length - 1].innerText : "";
    },

    inspector_click_next: function () { return "not-implemented-in-spike"; },
  };

  window.__LB_SPIKE__ = {
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
    has_ipc: hasIpc,
  };

  post({ t: "hello", url: location.href, has_ipc: hasIpc, has_global_tauri: !!window.__TAURI__ });
  document.addEventListener("DOMContentLoaded", function () {
    post({ t: "hello", url: location.href, has_ipc: hasIpc, has_global_tauri: !!window.__TAURI__, phase: "dom-ready" });
  });
})();
