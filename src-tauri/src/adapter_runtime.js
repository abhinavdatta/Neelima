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
  // Phase 3J: metadata-only send-lifecycle milestones (phase "sending"),
  // reusing the whitelisted watch_state path so a slow acknowledgement can be
  // attributed from the bridge log. Notes carry no page or prompt text.
  function sendPhase(note) {
    post({ t: "watch_state", runtime_id: RUNTIME_ID, phase: "sending", note: note, reply_seen: false, request_id: ACTIVE_REQUEST_ID, nonce: currentNonce() }).catch(function () {});
  }
  function reply(id, value, error) {
    if (!id) return; // fire-and-forget evals carry no id
    var v = JSON.stringify(error ? { ok: false, error: String((error && error.message) || error) } : { ok: true, value: value === undefined ? null : value });
    post({ t: "rpc_result", id: id, nonce: currentNonce(), v: v });
  }
  function parseArg(a) { return typeof a === "string" ? JSON.parse(a) : (a || {}); }
  // Mutation callbacks can outlive the document during navigation/unload.
  function q(sel) {
    try { return document && document.querySelector ? document.querySelector(sel) : null; }
    catch (e) { return null; }
  }
  function qAll(sel) {
    try {
      return document && document.querySelectorAll
        ? Array.prototype.slice.call(document.querySelectorAll(sel))
        : [];
    } catch (e) { return []; }
  }
  // ---- reply detection families (declared before boot) ----------------------
  // Providers change transcript markup over time. Live evidence (2025-2026)
  // documents at least three chatgpt.com layouts in rotation: role attributes,
  // list transcripts (`li[data-message-role]`), and per-turn wrappers whose
  // <article> became a <section>. Detection therefore tries several structural
  // identities — never generated utility classes. These arrays MUST be
  // assigned before the first boot() evaluation, because login detection
  // consults userTurnNodes() during startup.
  var ASSISTANT_MARKERS = [
    '[data-message-author-role="assistant"]',
    '[data-message-role="assistant"]',
    '[data-turn="assistant"]',
    '[data-author="assistant"]',
    '[data-author-role="assistant"]',
    '[data-testid="assistant-turn"]',
    // ChatGPT DIL renderer (observed 2026-10): turn-level search-unit keys
    // identify assistant turns; markdown is nested content, not a turn.
    '[data-content-search-unit-key$=":assistant"]',
    '[data-chatgpt-search-unit-key$=":assistant"]',
  ];
  var USER_MARKERS = [
    '[data-message-author-role="user"]',
    '[data-message-role="user"]',
    '[data-turn="user"]',
    '[data-author="user"]',
    '[data-author-role="user"]',
    '[data-testid="user-turn"]',
    // The list layout renders the prompt inside a button; treating action
    // buttons as UI chrome would otherwise delete the user's own turn.
    'button[data-user-message-bubble]'
  ];
  var TURN_WRAPPERS = [
    'article[data-testid^="conversation-turn"]',
    'section[data-testid^="conversation-turn"]',
    'li[data-testid^="conversation-turn"]',
    '[data-testid^="conversation-turn"]'
  ];

  function visible(el) {
    if (!el || !(el.getClientRects().length > 0 || el === document.activeElement)) return false;
    var style = window.getComputedStyle ? window.getComputedStyle(el) : null;
    return !style || (style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0");
  }
  function editable(el) {
    return !!(el && !el.disabled && !el.readOnly && (el.isContentEditable || /^(TEXTAREA|INPUT)$/.test(el.tagName)));
  }
  function findComposer() {
    var configured = S.input ? q(S.input) : null;
    if (visible(configured) && editable(configured)) return { element: configured, selector: S.input };
    // ChatGPT has changed the prompt element's attributes over time. Keep a
    // narrow, provider-specific fallback set; never select arbitrary buttons
    // or page text as an input.
    if (A.id === "chatgpt") {
      var fallbacks = [
        '[data-testid="prompt-textarea"]',
        '#prompt-textarea[contenteditable="true"]',
        'main [contenteditable="true"][role="textbox"]',
        'main textarea[placeholder*="Message"]',
        'main textarea[placeholder*="Ask"]'
      ];
      for (var i = 0; i < fallbacks.length; i++) {
        var candidates = qAll(fallbacks[i]);
        for (var j = 0; j < candidates.length; j++) {
          if (visible(candidates[j]) && editable(candidates[j])) return { element: candidates[j], selector: fallbacks[i] };
        }
      }
    }
    return { element: null, selector: S.input || "(no input selector configured)" };
  }
  function challengeReason() {
    var href = (location.href || "").toLowerCase();
    if (/captcha|challenge|\/verify(?:\/|$)/.test(href)) return "provider challenge or verification page";
    if (q('iframe[src*="captcha"], [data-sitekey], [id*="captcha"], [class*="captcha"]')) return "provider challenge or CAPTCHA detected";
    return "";
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
  // A composer can be available on ChatGPT before authentication. Require an
  // account-only marker there so opening the sign-in view is not mistaken for
  // completing sign-in.
  function onLoginPage() {
    var href = location.href || "";
    for (var i = 0; i < LOGIN_PATTERNS.length; i++) {
      try { if (href.indexOf(LOGIN_PATTERNS[i]) !== -1) return true; } catch (e) {}
    }
    return false;
  }
  function hasLoggedInMarker() {
    var selectors = [];
    // Configured logged_in selector (from adapter JSON). Older adapter copies
    // pointed this at the COMPOSER itself, which made every signed-out page
    // look authenticated; ignore such a marker.
    var configuredLogin = S.logged_in ? q(S.logged_in) : null;
    if (S.logged_in && S.logged_in !== S.input && configuredLogin && !editable(configuredLogin)) {
      selectors.push(S.logged_in);
    }
    // Provider-specific authenticated UI markers (multiple verified variants)
    if (A.id === "chatgpt") {
      selectors.push(
        '[data-testid="profile-button"]',
        '[aria-label="Open profile menu"]',
        '[data-testid="account-menu-button"]',
        '[data-testid="accounts-profile-button"]',
        '[aria-label="Account"]',
        '[data-testid="model-switcher-dropdown"]',
        '[data-testid="model-switcher"]',
        'img[alt*="profile" i]',
        'img[alt*="avatar" i]',
        // Sidebar conversation history only renders for a signed-in account.
        'nav a[href^="/c/"]'
      );
    } else if (A.id === "claude") {
      selectors.push(
        '[data-testid="profile-menu-button"]',
        '[aria-label="Account menu"]',
        'button[aria-label*="account" i]'
      );
    } else if (A.id === "gemini") {
      selectors.push(
        '[data-testid="account-menu-button"]',
        '[aria-label="Google Account"]',
        'button[aria-label*="account" i]'
      );
    }
    for (var i = 0; i < selectors.length; i++) {
      if (visible(q(selectors[i]))) return true;
    }
    // An existing conversation turn is positive evidence of an authenticated
    // session (the page rendered a prior chat for this account).
    if (userTurnNodes().length > 0) return true;
    return false;
  }
  function hasLoggedOutMarker() {
    var selectors = [];
    if (S.logged_out) selectors.push(S.logged_out);
    if (A.id === "chatgpt") {
      selectors.push(
        'a[href*="/auth/login"]',
        'a[data-testid="login-button"]',
        'button[data-testid="welcome-login-button"]',
        '[data-testid="login-button"]',
        'a[href*="accounts.google.com"]',
        'a[href*="auth0.openai.com"]'
      );
    } else if (A.id === "claude") {
      selectors.push(
        'a[href*="/login"]',
        'button[data-testid="login-button"]'
      );
    } else if (A.id === "gemini") {
      selectors.push(
        'a[href*="/signin"]',
        'button[aria-label*="sign in" i]'
      );
    }
    for (var i = 0; i < selectors.length; i++) {
      if (visible(q(selectors[i]))) return true;
    }
    return false;
  }
  function evalLogin() {
    if (document.readyState !== "complete" || !document.body) {
      return { state: "loading", reason: "provider document is still loading" };
    }
    var challenge = challengeReason();
    if (challenge) return { state: "challenge", reason: challenge };
    if (onLoginPage()) {
      return { state: "logged_out", reason: "on a login/auth page" };
    }
    var found = findComposer();
    var composer = found.element;
    var composerVisible = visible(composer);
    // Explicit logged-out markers take precedence
    if (hasLoggedOutMarker()) {
      return { state: "logged_out", reason: "logged-out marker visible" };
    }
    if (composerVisible) {
      if (hasLoggedInMarker()) return { state: "logged_in", reason: "authenticated account marker found" };
      // A composer is NOT proof of an authenticated account. The three bundled
      // AI sites always render an account/profile control when signed in, so
      // report "unknown" (sending is still attempted when the composer is
      // usable). User-built generic adapters may have no account concept.
      if (A.id === "chatgpt" || A.id === "claude" || A.id === "gemini") {
        return { state: "unknown", reason: "message composer found, but no authenticated account marker was detected" };
      }
      return { state: "logged_in", reason: "supported message composer found and no logged-out signals" };
    }
    var app = document.querySelector("main");
    return {
      state: "unknown",
      reason: app
        ? "chat page loaded, but no supported message composer was found; refresh the provider sign-in window or choose a configured API/local model"
        : "provider page loaded without a chat application root; check sign-in, network, or provider availability"
    };
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
    var key = r.state + "|" + r.reason + "|" + location.href;
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
    post({ t: "ready", runtime_id: RUNTIME_ID, url: location.href, has_ipc: hasIpc(), nonce: currentNonce() }).catch(function () {});
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
  var RUNTIME_ID = (window.crypto && typeof window.crypto.randomUUID === "function")
    ? window.crypto.randomUUID()
    : (String(Date.now()) + "-" + String(Math.random()).slice(2));
  // Metadata-only watch diagnostics, surfaced through page_info/Test
  // connection. Never carries page text.
  var WATCH_STATS = { attached_target: null, connected: false, callbacks: 0 };
  var LAST_SEND_AT = 0;
  // Correlation ID supplied by Rust for THIS send. Every push/watch message
  // echoes it so a late completion from an earlier round can never satisfy a
  // later wait (Rust rejects a mismatched or missing ID).
  var ACTIVE_REQUEST_ID = "";
  // The page-side completion watch for the active send. A new send or an
  // explicit cancel tears it down, so an abandoned round can never push a
  // late "completed" into the next request's window.
  var ACTIVE_WATCH = null;
  // One submission at a time: two overlapping send_message calls could type
  // into the same composer and click twice.
  var SEND_IN_FLIGHT = false;
  // The prompt this page last received (normalized). Used ONLY to refuse a
  // content block that is the user's own message: on a page whose prompts are
  // rendered by the same markdown pipeline as answers, the newest block may be
  // the prompt itself until the model replies. Never pushed anywhere.
  var LAST_SENT_TEXT = "";

  // The desktop app parks (moves off-screen) or hides the provider webview
  // during ordinary work; WebView2 may then report the page as hidden and
  // throttle timers/rendering. Neelima owns this page — it must behave as if
  // visible so its timers and layout stay live during a task.
  (function forceVisible() {
    try {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: function () { return "visible"; }
      });
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: function () { return false; }
      });
      document.addEventListener("visibilitychange", function (e) {
        e.stopImmediatePropagation();
      }, true);
    } catch (e) { /* older engines: the browser args cover throttling */ }
  })();

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

  // Wrapper nodes carry provider chrome ("ChatGPT said", "Gemini said",
  // action rows, copy buttons). Prefer the innermost CONTENT node so the
  // parsed reply is model output, not page furniture. Falls back to the node
  // itself, which is what ChatGPT and Claude commonly expose.
  function contentTarget(node) {
    // A ChatGPT DIL turn can contain an inner sibling with the same turn key
    // but only assistant markdown has model content (and nested UI chrome).
    // Prefer the observed markdown body when selecting the turn's extraction root.
    if (A.id === "chatgpt") {
      var chatgptBody = null;
      try { chatgptBody = node.querySelector('[data-markdown-text-style="assistant-message"]'); } catch (e) {}
      if (chatgptBody) return chatgptBody;
    }
    var prefs = [
      "[data-message-content]",
      '[data-markdown-text-style="assistant-message"]',
      "[data-message-author-role='assistant']",
      ".font-claude-message",
      "message-content",
      ".model-response-text",
      // Answer bodies of the current layouts (ChatGPT/Claude/Gemini all ship
      // one of these). Only consulted INSIDE a node already identified as an
      // assistant turn, so a prompt can never be picked here.
      ".markdown",
      ".prose",
      ".whitespace-pre-wrap"
    ];
    for (var i = 0; i < prefs.length; i++) {
      var found;
      try { found = node.querySelectorAll(prefs[i]); } catch (e) { found = []; }
      for (var j = found.length - 1; j >= 0; j--) {
        var text = found[j].innerText || found[j].textContent || "";
        if (text.trim()) return found[j];
      }
    }
    return node;
  }

  // Provider pages render fenced code as <pre><code>, but the literal ```
  // fence characters are never text nodes, so plain innerText captures lose
  // them. That silently broke the ```tool protocol: the JSON and nonce
  // survived, the fences did not, and Rust parsed zero tool calls.
  // serializeAssistantText walks the content node and re-emits each code
  // block as a proper fenced block, restoring ``` markers. Nodes without
  // <pre> produce plain innerText exactly as before.
  function isPreNode(el) {
    return !!el && el.tagName === "PRE";
  }

  function preLangOf(pre) {
    var code = pre.querySelector("code") || pre;
    var cls = ((code.className || "") + " " + (pre.className || ""));
    var m = cls.match(/language-([a-zA-Z0-9_+-]+)/);
    if (m) return m[1];
    // The rendered info-string often sits in a small header row beside the
    // code block ("tool", "python", ...) — a short single token that is not
    // UI furniture. Never descend below the code block itself.
    var host = pre.parentElement;
    if (host) {
      var kids = host.querySelectorAll("pre, div, label, span");
      for (var i = 0; i < kids.length; i++) {
        if (kids[i] === pre || pre.contains(kids[i])) continue;
        var t = ((kids[i].innerText || kids[i].textContent || "").trim());
        if (t && t.length <= 24 && !/\s/.test(t) && !/^(copy|edit|share|download|expand|collapse)/i.test(t)) {
          return t;
        }
      }
    }
    return "";
  }

  function serializedAssistantText(node) {
    var text = node ? (node.innerText || node.textContent || "") : "";
    var pre = null;
    try {
      pre = node && node.querySelector && node.querySelector("pre");
    } catch (e) { pre = null; }
    if (!pre) return stripUiNoise(text);
    // Fenced content exists: rebuild the message block by block.
    var out = "";
    var walk = function (el, insidePreHeader) {
      var kids = el.childNodes;
      for (var i = 0; i < kids.length; i++) {
        var ch = kids[i];
        if (ch.nodeType === 3) {
          out += ch.nodeValue || "";
        } else if (ch.nodeType !== 1) {
          // comments etc.
        } else if (isPreNode(ch)) {
          var lang = preLangOf(ch) || insidePreHeader || "";
          var codeEl = ch.querySelector("code") || ch;
          var body = (codeEl.textContent || "").replace(/\n$/, "");
          out += "```" + lang + "\n" + body + "\n```\n";
        } else {
          var hasDeepPre = false;
          try { hasDeepPre = !!ch.querySelector("pre"); } catch (e) {}
          if (hasDeepPre) {
            walk(ch, insidePreHeader);
          } else {
            out += (ch.innerText || ch.textContent || "");
          }
        }
      }
    };
    walk(node, "");
    return stripUiNoise(out);
  }

  // Live evidence (2026-10, chatgpt.com "DIL" renderer): the whole assistant
  // reply — INCLUDING what the model wrote as fenced ```tool blocks — can be
  // flattened into ONE <p data-d-component="text"> with small inline
  // <code data-d-component="code"> spans. There is no <pre>, so preLangOf
  // never fires, and the literal fence characters exist nowhere in the DOM.
  // Rust's parser requires both the ```tool opener and the ``` closer, so the
  // capture must restore BOTH markers. The restorer is deliberately narrow:
  // only a line that is exactly "tool" immediately followed by text that
  // parses as a tool-shaped JSON object (string id/tool, optional k, object
  // args) is wrapped, and the wrapping ends at the JSON's closing brace.
  // Prose not matching that shape is never touched, and the per-task nonce
  // check in Rust still guards anything that gets wrapped.
  function looksLikeToolJson(s) {
    try {
      var v = JSON.parse(s);
      if (!v || typeof v !== "object" || Array.isArray(v)) return false;
      if (typeof v.id !== "string" || !v.id) return false;
      if (typeof v.tool !== "string" || !v.tool) return false;
      if (typeof v.k === "undefined" || v.k === null || typeof v.k === "string") { /* ok */ }
      else return false;
      if (typeof v.args !== "undefined" && v.args !== null && typeof v.args !== "object") return false;
      return true;
    } catch (e) { return false; }
  }

  function restoreFlattenedToolFences(text) {
    if (!text || text.indexOf("`") !== -1) return text; // fences already present — the pre path owns those
    var linesRaw = text.split("\n");
    var out = [];
    var i = 0;
    var wrappedAny = false;
    while (i < linesRaw.length) {
      var t = linesRaw[i].trim();
      if (/^tool$/.test(t) && i + 1 < linesRaw.length) {
        var body = [];
        var j = i + 1;
        var found = false;
        while (j < linesRaw.length && !found) {
          // Strip literal escape-furniture tokens some renderers leave in the
          // flattened text before testing the JSON shape.
          var ln = linesRaw[j].replace(/<\/?escape>/g, "");
          body.push(ln);
          var bt = body.join("\n").trim();
          if (bt.length > 0 && bt.charAt(bt.length - 1) === "}") {
            if (looksLikeToolJson(bt)) {
              out.push("```tool");
              out.push(bt);
              out.push("```");
              wrappedAny = true;
              found = true;
              i = j + 1;
              break;
            } else {
              break; // closing brace reached but not tool-shaped: never fabricate
            }
          }
          if (ln.trim() === "") break; // blank line before any closing brace: not a tool block
          j += 1;
        }
        if (found) continue;
      }
      out.push(linesRaw[i]);
      i += 1;
    }
    if (!wrappedAny) return text;
    return out.join("\n");
  }

  function replyText(node) {
    return restoreFlattenedToolFences(serializedAssistantText(node));
  }

  // ---- reply candidates across provider layouts ----------------------------
  // Providers change transcript markup over time. Live evidence (2025-2026)
  // documents at least three layouts on chatgpt.com alone: role attributes
  // (`data-message-author-role`), list transcripts (`li[data-message-role]`),
  // and per-turn wrappers whose `<article>` became a `<section>`. A single
  // selector therefore silently returns ZERO nodes on a rolled-out layout —
  // the reply is visibly on screen but Neelima reports "no reply". Detection
  // tries structural identities only (role/data/testid attributes, the
  // provider's own "… said" label) — never generated utility classes.
  function uniqueInDocumentOrder(nodes) {
    var out = [];
    var seen = [];
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i] && seen.indexOf(nodes[i]) === -1) { seen.push(nodes[i]); out.push(nodes[i]); }
    }
    if (out.length > 1) {
      try {
        out.sort(function (a, b) {
          if (a === b) return 0;
          return (a.compareDocumentPosition(b) & 4) ? -1 : 1; // 4 = DOCUMENT_POSITION_FOLLOWING
        });
      } catch (e) { /* keep query order */ }
    }
    return out;
  }

  // A nested marker (e.g. the prompt bubble inside its own list item, or a
  // role node inside its turn wrapper) would otherwise be counted twice and
  // make "a new turn appeared" ambiguous. This runs on EVERY mutation during
  // streaming, so it must stay linear: inputs are in document order, which
  // means a container is immediately followed by its descendants — compare
  // only against the last kept node and prefer the INNER one (the precise
  // content node, not the wrapper with the provider's chrome).
  function dropNested(nodes) {
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var prev = out.length ? out[out.length - 1] : null;
      try {
        if (prev && prev !== nodes[i] && prev.contains && prev.contains(nodes[i])) {
          out[out.length - 1] = nodes[i];
          continue;
        }
      } catch (e) { /* detached node: keep it */ }
      out.push(nodes[i]);
    }
    return out;
  }

  function hasUserMarker(node) {
    if (!node) return false;
    for (var i = 0; i < USER_MARKERS.length; i++) {
      try { if (node.matches(USER_MARKERS[i])) return true; } catch (e) {}
      try { if (node.querySelector(USER_MARKERS[i])) return true; } catch (e) {}
    }
    return false;
  }

  // Every assistant turn the page currently exposes, oldest → newest.
  function assistantTurnNodes() {
    var nodes = [];
    if (S.messages) nodes = nodes.concat(qAll(S.messages));
    nodes = nodes.concat(qAll(ASSISTANT_MARKERS.join(", ")));
    if (nodes.length) return dropNested(uniqueInDocumentOrder(nodes));
    // Wrapper layout: the role lives on the wrapper, on a descendant, or only
    // in the provider's own speaker label. Never accept a wrapper that also
    // carries a user marker — that is the prompt.
    var wrappers = qAll(TURN_WRAPPERS.join(", "));
    var out = [];
    for (var i = 0; i < wrappers.length; i++) {
      var w = wrappers[i];
      var role = "";
      try {
        role = String(
          (w.getAttribute && (w.getAttribute("data-message-role") || w.getAttribute("data-turn") || w.getAttribute("data-author"))) || ""
        ).toLowerCase();
      } catch (e) { role = ""; }
      if (role === "user") continue;
      if (role === "assistant") { out.push(w); continue; }
      var marker = null;
      for (var m = 0; m < ASSISTANT_MARKERS.length && !marker; m++) {
        try { marker = w.querySelector(ASSISTANT_MARKERS[m]); } catch (e) { marker = null; }
      }
      if (marker) { out.push(marker); continue; }
      // jsdom (and older engines) have no innerText: fall back to textContent.
      var label = (w.innerText || w.textContent || "");
      if (A.id === "chatgpt") {
        // Preserve the known conversation-turn wrapper layout only when both
        // structural scope and an explicit assistant speaker label are present.
        // Unanchored hero/suggestion copy remains ineligible.
        var testId = "";
        try { testId = String(w.getAttribute("data-testid") || ""); } catch (e) {}
        if (/^conversation-turn(?:-|$)/i.test(testId) && /^\s*ChatGPT\s+said\b/i.test(label)) {
          out.push(w);
        }
        continue;
      }
      if (!hasUserMarker(w) && /(chatgpt|claude|gemini|assistant|copilot)\s*said/i.test(label)) {
        out.push(w);
      }
    }
    return dropNested(uniqueInDocumentOrder(out));
  }

  // Metadata-only: which detection family currently matches. Surfaced through
  // page_info so a live failure can say "layout unknown" instead of silently
  // finding nothing.
  function replyLayout() {
    if (S.messages && qAll(S.messages).length) return "adapter";
    if (qAll(ASSISTANT_MARKERS.join(", ")).length) return "role";
    // Keep diagnostics in sync with the narrow wrapper fallback used by
    // assistantTurnNodes; arbitrary wrappers and landing-page copy still fail closed.
    if (A.id === "chatgpt") {
      if (assistantTurnNodes().length) return "turns";
      return userTurnNodes().length ? "user-anchor" : "none";
    }
    if (qAll(TURN_WRAPPERS.join(", ")).length) return "turns";
    if (contentReplyCandidates().length) return "content";
    if (userTurnNodes().length) return "user-anchor";
    return "none";
  }

  // ---- attribute-free fallback ---------------------------------------------
  // A provider may rename EVERY message attribute (this is what happened on a
  // live chatgpt.com page: no data-message-author-role, no
  // data-testid=conversation-turn-*) and still render the answer into a
  // markdown/prose block. Analysis then falls back to content structure: the
  // answer is the LAST non-empty content block that appears AFTER the user's
  // own turn and is not inside it. Cheap on purpose (a handful of
  // querySelectorAll calls, no full-document scans, no shadow walk) because
  // this runs inside the mutation callback while a reply streams.
  var CONTENT_BLOCKS = [
    "[data-message-content]",
    ".markdown",
    ".prose",
    '[class*="markdown" i]',
    ".whitespace-pre-wrap"
  ];

  function insideUserTurn(node) {
    var cur = node;
    var guard = 0;
    while (cur && cur !== document.body && cur !== document.documentElement && guard++ < 40) {
      if (isUserTurnNode(cur)) return true;
      try {
        var testid = (cur.getAttribute && cur.getAttribute("data-testid")) || "";
        if (/user/i.test(testid)) return true;
      } catch (e) { /* detached */ }
      cur = cur.parentElement;
    }
    return false;
  }

  function looksLikeSentPrompt(text) {
    var t = normalizedMessage(text);
    if (!t || !LAST_SENT_TEXT) return false;
    if (t === LAST_SENT_TEXT) return true;
    // Long prompts are truncated/collapsed by provider UIs ("Show more").
    if (t.length > 240 && LAST_SENT_TEXT.length > 120) {
      return (
        t.slice(0, 120) === LAST_SENT_TEXT.slice(0, 120) &&
        t.slice(-120) === LAST_SENT_TEXT.slice(-120)
      );
    }
    return false;
  }

  function contentReplyCandidates() {
    var nodes = [];
    for (var i = 0; i < CONTENT_BLOCKS.length; i++) {
      nodes = nodes.concat(qAll(CONTENT_BLOCKS[i]));
    }
    nodes = dropNested(uniqueInDocumentOrder(nodes));
    var users = userTurnNodes();
    var anchor = users.length ? users[users.length - 1] : null;
    var out = [];
    for (var j = 0; j < nodes.length; j++) {
      var node = nodes[j];
      if (insideUserTurn(node)) continue;
      if (anchor) {
        // The answer must follow the confirmed prompt in document order.
        try {
          if (!(anchor.compareDocumentPosition(node) & 4)) continue; // 4 = FOLLOWING
        } catch (e) { /* detached: keep */ }
      }
      var nodeText = node.innerText || node.textContent || "";
      if (!nodeText.trim()) continue;
      // The user's own prompt must never be returned as the model's answer.
      if (looksLikeSentPrompt(nodeText)) continue;
      out.push(node);
    }
    return out;
  }

  /// Metadata-only structural outline for live diagnosis: tag names, data/aria
  /// attribute names, child counts and text LENGTHS. Never page text.
  function domOutline(node, maxAttrs) {
    var attrs = [];
    try {
      var list = (node.attributes || []);
      for (var i = 0; i < list.length && attrs.length < maxAttrs; i++) {
        var name = String(list[i].name);
        if (name === "class") {
          attrs.push("class=" + String(list[i].value || "").split(/\s+/).slice(0, 3).join(".").slice(0, 60));
        } else if (/^(data-|aria-label$|role$|id$|contenteditable$)/i.test(name)) {
          attrs.push(name + "=" + String(list[i].value || "").slice(0, 48));
        }
      }
    } catch (e) { /* detached */ }
    return {
      tag: String(node.tagName || "").toLowerCase(),
      attrs: attrs,
      children: (node.children && node.children.length) || 0,
      text_len: (node.innerText || node.textContent || "").length
    };
  }

  /// Bounded deep outline (metadata only): tag/attr of descendants down to
  /// `maxDepth` levels, at most `maxNodes` nodes total. Never page text.
  function domDeep(node, maxDepth, maxNodes) {
    var out = [];
    function walk(el, depth) {
      if (out.length >= maxNodes || depth > maxDepth) return;
      try {
        for (var i = 0; i < el.children.length && out.length < maxNodes; i++) {
          var kid = domOutline(el.children[i], 4);
          kid.depth = depth;
          out.push(kid);
          if (depth < maxDepth) walk(el.children[i], depth + 1);
        }
      } catch (e) { /* detached */ }
    }
    walk(node, 1);
    return out;
  }

  function replyDomReport() {
    var blocks = contentReplyCandidates();
    var report = { layout: replyLayout(), blocks: [], chain: [], markers: 0, wrappers: 0 };
    try { report.markers = qAll(ASSISTANT_MARKERS.join(", ")).length; } catch (e) {}
    try { report.wrappers = qAll(TURN_WRAPPERS.join(", ")).length; } catch (e) {}
    var start = Math.max(0, blocks.length - 3);
    // Metadata structure of the last content candidates, plus a bounded DEEP
    // outline of the newest one (2 levels, ≤24 nodes). This is what shows
    // whether a live layout renders fenced code as <pre> or as something else —
    // still tags/attr names/counts/text lengths only, never page text.
    for (var i = start; i < blocks.length; i++) {
      var o = domOutline(blocks[i], 8);
      if (i === blocks.length - 1) o.deep = domDeep(blocks[i], 10, 220);
      report.blocks.push(o);
    }
    // Ancestor chain of the newest block: shows WHERE the answer lives, which
    // is what a selector needs. Bounded to 8 levels, no text.
    var last = blocks.length ? blocks[blocks.length - 1] : null;
    var cur = last ? last.parentElement : null;
    var depth = 0;
    while (cur && cur !== document.body && depth++ < 8) {
      report.chain.push(domOutline(cur, 6));
      cur = cur.parentElement;
    }
    return report;
  }

  // Some adapters (the demo page, a user-built generic adapter) list BOTH
  // roles under `messages`. The last turn can then be the user's own prompt;
  // returning it would push the prompt back as if it were the model's answer.
  function isUserTurnNode(node) {
    if (!node) return false;
    try {
      if (S.user_message && node.matches(S.user_message)) return true;
      if (node.matches('[data-message-author-role="user"]')) return true;
    } catch (e) { /* invalid optional selector: treat as assistant */ }
    for (var i = 0; i < USER_MARKERS.length; i++) {
      try { if (node.matches(USER_MARKERS[i])) return true; } catch (e) {}
    }
    return false;
  }

  function lastAssistantNode(nodes) {
    for (var i = nodes.length - 1; i >= 0; i--) {
      if (!isUserTurnNode(nodes[i])) return nodes[i];
    }
    return null;
  }

  // Reply extraction runs inside mutation callbacks (and each callback asks for
  // it several times). With the layout families plus the content fallback that
  // is ~10 querySelectorAll passes per call — wasteful on a long transcript.
  // The memo is keyed on a DOM VERSION that a mutation bumps, NOT on a timer:
  // a time-based cache would let a single mutation batch sample a pre-change
  // snapshot and miss the reply entirely (the watch is mutation-driven, so
  // there may be no second callback to correct it). Within one batch the DOM is
  // unchanged, so this collapses repeated scans without ever hiding a change.
  var DOM_VERSION = 0;
  var EXTRACT_VERSION = -1;
  var EXTRACT_VALUE = null;

  function extractedLast(force) {
    if (!force && EXTRACT_VALUE && EXTRACT_VERSION === DOM_VERSION) return EXTRACT_VALUE;
    var value = extractNow();
    EXTRACT_VERSION = DOM_VERSION;
    EXTRACT_VALUE = value;
    return value;
  }

  function extractNow() {
    var nodes = assistantTurnNodes();
    if (nodes.length) {
      var last = lastAssistantNode(nodes);
      if (!last) return { count: nodes.length, text: "", has_reply: false };
      var markerText = replyText(contentTarget(last));
      // An attribute match whose text is empty is not the answer: fall through
      // to the content-structure fallback instead of reporting "no reply".
      if (markerText) return { count: nodes.length, text: markerText, has_reply: true };
    }
    // On ChatGPT, content markup is a reply only when it belongs to a specific
    // turn-level assistant key. A nested markdown style marker or overlapping
    // search key by itself is not enough to identify a distinct turn.
    if (A.id === "chatgpt") return { count: nodes.length, text: "", has_reply: false };
    // On ChatGPT, generic markdown/sibling content can be landing-page copy or
    // other UI. Only an identified assistant turn may produce a reply.
    var blocks = contentReplyCandidates();
    if (blocks.length) {
      var blockText = replyText(contentTarget(blocks[blocks.length - 1]));
      if (blockText) {
        return { count: blocks.length, text: blockText, has_reply: true };
      }
    }
    // Provider-DOM-drift fallback: providers rename message attributes over
    // time. Anchor on the CONFIRMED user turn (its selectors have class-based
    // fallbacks) and treat the sibling that follows it as the assistant reply.
    var users = userTurnNodes();
    if (!users.length) return { count: 0, text: "", has_reply: false };
    var anchor = users[users.length - 1];
    var reply = anchor.parentElement ? anchor.nextElementSibling : null;
    if (!reply || reply === anchor) return { count: users.length, text: "", has_reply: false };
    return {
      count: users.length + 1,
      text: replyText(contentTarget(reply)),
      has_reply: true
    };
  }

  // Provider-agnostic streaming controls. Claude/Gemini ship different labels
  // and Gemini's adapter historically omitted a stop selector entirely; a
  // missing selector must not mean "generation already finished".
  var STOP_FALLBACKS = [
    '[data-testid="stop-button"]',
    'button[aria-label*="Stop response" i]',
    'button[aria-label*="Stop generating" i]',
    'button[aria-label*="Stop streaming" i]'
  ];

  function stopVisible() {
    // Use the shared visibility helper: `offsetParent` is null for
    // position:fixed elements even when they are on screen, which would make
    // streaming completion undetectable and could push partial replies.
    // A mutation callback can fire while the document is being torn down.
    if (typeof document === "undefined" || !document) return false;
    if (S.stop_button && visible(q(S.stop_button))) return true;
    var root = document.querySelector ? document.querySelector("main") || document : null;
    if (!root || !root.querySelector) return false;
    for (var i = 0; i < STOP_FALLBACKS.length; i++) {
      var found;
      try { found = root.querySelector(STOP_FALLBACKS[i]); } catch (e) { found = null; }
      if (visible(found)) return true;
    }
    return false;
  }

    function waitResponse(arg) {
        var cfg = parseArg(arg);
        var quiet = cfg.quiet_ms || A.quiet_ms || 2000;
        var deadlineMs = cfg.timeout_ms || A.response_timeout_ms || 300000;
        var cancelWait = null;
        // A new watch supersedes the previous one: stop its observer/timers so
        // a late completion from an older round cannot be reported as this
        // round's answer.
        var previous = ACTIVE_WATCH;
        ACTIVE_WATCH = null;
        if (previous && typeof previous.cancel === "function") {
            try { previous.cancel({ from: "superseded" }); } catch (e) { /* already finished */ }
        }
        var promise = new Promise(function (resolve) {
            // Watch the whole document for the ENTIRE wait: an SPA can replace
            // the conversation <main> mid-stream, which silently deafens an
            // observer pinned to the landing container. Start/completion read
            // the live DOM on every callback, so the observed root only needs
            // to be stable — document.body (or documentElement) is.
            var root = document.body || document.documentElement;
            if (!root) { resolve({ error: "provider page has no observable root" }); return; }
            var obs = null, quietTimer = null, startTimer = null, deadlineTimer = null;
            var startedAt = Date.now();
            var phase = "waiting_start"; // waiting_start -> generating -> done
            var baseline = extractedLast();
            var baselineCount = baseline.count;
            var baselineText = baseline.text;
            var armedText = null; // content snapshot taken when the quiet timer was armed
            var stableConfirmed = false; // second quiet window for stop-less providers
            var sawStop = false; // was the provider's stop control ever observed?
            var noReplyWindows = 0; // quiet windows with no new reply (error detection)
            var lastPartialText = "";
            var lastPartialAt = 0;
            WATCH_STATS.attached_target = (root.tagName || "body").toLowerCase();
            WATCH_STATS.connected = true;
            WATCH_STATS.callbacks = 0;

            var watchToken = { cancel: null };
            ACTIVE_WATCH = watchToken;
            function finish(v) {
                WATCH_STATS.connected = false;
                if (obs) obs.disconnect();
                if (quietTimer) clearTimeout(quietTimer);
                if (startTimer) clearTimeout(startTimer);
                if (deadlineTimer) clearTimeout(deadlineTimer);
                if (ACTIVE_WATCH === watchToken) ACTIVE_WATCH = null;
                resolve(v);
            }
            cancelWait = function (why) {
                finish({ error: "cancelled", reason: (why && why.from) || "cancelled" });
            };
            watchToken.cancel = function (why) { cancelWait(why); };

            function reportPush(text) {
                ASSIST_SEQ += 1;
                post({ t: "assistant_message", runtime_id: RUNTIME_ID, seq: ASSIST_SEQ, text: text, request_id: ACTIVE_REQUEST_ID, nonce: currentNonce() }).catch(function () {});
            }

            // The provider showed a stop control, then ended generation without
            // producing a new assistant turn (error, interruption, or removed
            // response). Report the failure so Rust fails the wait now instead
            // of sitting out the full response deadline.
            function failWithoutReply() {
                var reason = "the provider stopped generating without adding a new assistant reply (it may have reported an error)";
                post({
                    t: "response_error",
                    runtime_id: RUNTIME_ID,
                    request_id: ACTIVE_REQUEST_ID,
                    code: "provider_error",
                    message: reason,
                    nonce: currentNonce()
                }).catch(function () {});
                noteWatch("generation ended without a reply");
                finish({ error: "provider_error", error_message: reason });
            }

            // A reply is new only when the assistant turn count grew OR the
            // text differs from the pre-send snapshot. Providers that stream
            // into ONE reused container never grow the count, so a count-only
            // test would either miss the answer or push the previous turn.
            function isNewReply(cur) {
                return !!cur.text && (cur.count > baselineCount || cur.text !== baselineText);
            }

            // Metadata-only lifecycle diagnostics (never page text): lets a
            // live failure be diagnosed from the bridge log instead of dying
            // silently. Bounded — posted on transitions, not per mutation.
            var lastNoteAt = 0;
            function noteWatch(note) {
                // Bounded: transitions are always reported; repetitive "still
                // waiting" ticks at most once every 10 s, so a live failure is
                // diagnosable without flooding the bridge log.
                var now = Date.now();
                if (now - lastNoteAt < 10000 && note.indexOf("waiting") === 0) return;
                lastNoteAt = now;
                post({
                    t: "watch_state",
                    runtime_id: RUNTIME_ID,
                    phase: phase,
                    note: note,
                    reply_seen: extractedLast().has_reply,
                    request_id: ACTIVE_REQUEST_ID,
                    nonce: currentNonce()
                }).catch(function () {});
            }

            // Streaming preview: a display-only tail, throttled and capped so a
            // long file-writing reply cannot flood IPC. The agent still acts
            // only on the completed push below.
            var PARTIAL_CAP = 8000;
            function maybePartial() {
                if (phase !== "generating") return;
                var now = Date.now();
                if (now - lastPartialAt < 700) return;
                var cur = extractedLast();
                if (!isNewReply(cur) || cur.text === lastPartialText) return;
                lastPartialAt = now;
                lastPartialText = cur.text;
                var preview = cur.text.length > PARTIAL_CAP ? cur.text.slice(-PARTIAL_CAP) : cur.text;
                post({
                    t: "assistant_partial",
                    runtime_id: RUNTIME_ID,
                    request_id: ACTIVE_REQUEST_ID,
                    text: preview,
                    truncated: preview.length < cur.text.length,
                    nonce: currentNonce()
                }).catch(function () {});
            }

            function stopNow() {
                var s = stopVisible();
                if (s) sawStop = true;
                return s;
            }

            function checkStart() {
                var cur = extractedLast();
                var genStarted = stopNow() || cur.count > baselineCount || cur.text !== baselineText;
                if (genStarted) {
                    phase = "generating";
                    if (startTimer) clearTimeout(startTimer);
                    noteWatch("generation started");
                    armQuiet();
                    maybePartial();
                }
            }

            // Quiet timer: completion = content unchanged for `quiet` ms AND no
            // stop control. Re-arming on every mutation would let pure
            // attribute churn (animations, aria-busy, class flips) starve the
            // timer forever — so the timer fires against the CONTENT snapshot
            // taken when it was armed: same text + no stop button = done.
            function armQuiet() {
                if (quietTimer) return; // already armed; fire-time comparison decides
                armedText = extractedLast().text;
                quietTimer = setTimeout(function () {
                    quietTimer = null;
                    if (stopNow()) return; // completion will be reconsidered on DOM mutation
                    var cur = extractedLast();
                    if (!cur.has_reply && !cur.text) {
                        // The reply container has not appeared yet (provider may
                        // take a moment) — keep waiting under the deadline.
                        noReplyWindows += 1;
                        if (sawStop && !stopNow() && noReplyWindows >= 2) {
                            failWithoutReply();
                            return;
                        }
                        armQuiet();
                        return;
                    }
                    if (!isNewReply(cur)) {
                        // No NEW reply yet. This is the normal state for a
                        // reused provider chat: the old reply is still the last
                        // assistant node while the model is thinking. Keep
                        // waiting under the deadline. EXCEPTION: if the stop
                        // control was observed and has now disappeared, the
                        // provider ended the turn without adding a reply — an
                        // error/interruption. Report it instead of spinning
                        // until the full timeout.
                        noReplyWindows += 1;
                        if (sawStop && !stopNow() && noReplyWindows >= 2) {
                            failWithoutReply();
                            return;
                        }
                        noteWatch("waiting for a new assistant reply");
                        armQuiet();
                        return;
                    }
                    noReplyWindows = 0;
                    if (cur.text !== armedText) {
                        // Still streaming: re-arm against the newer content.
                        stableConfirmed = false;
                        armQuiet();
                        return;
                    }
                    if ((!S.stop_button || !sawStop) && !stableConfirmed) {
                        // No completion control was ever observed (Gemini ships
                        // none; another provider's selector may have drifted).
                        // One quiet window is not enough evidence: a stream
                        // pause looks identical to a finished answer. Require a
                        // second, independent quiet window.
                        stableConfirmed = true;
                        noteWatch("reply stable; confirming once more");
                        armQuiet();
                        return;
                    }
                    reportPush(cur.text);
                    noteWatch("completed");
                    finish({ complete: true, elapsed: Date.now() - startedAt });
                }, quiet);
            }

            obs = new MutationObserver(function () {
                WATCH_STATS.callbacks += 1;
                DOM_VERSION += 1;
                if (phase === "waiting_start") { checkStart(); return; }
                // Generating: the armed timer's fire-time content comparison
                // owns completion; a fire during streaming re-arms against the
                // newer text.
                maybePartial();
                if (!quietTimer) armQuiet();
            });
            // childList + characterData only: attribute churn from page
            // animations must not drive the completion watch.
            obs.observe(root, { childList: true, subtree: true, characterData: true });

            // Start watchdog: if the start signal is blind (stale selectors,
            // quiet page), KEEP waiting — the overall deadline is the honest
            // bound. Killing the watch here silently produced "response
            // timeout" with the reply already rendered on the page.
            startTimer = setTimeout(function () {
                if (phase === "waiting_start") {
                    var cur = extractedLast();
                    if (stopNow() || cur.count > baselineCount || cur.text !== baselineText) {
                        phase = "generating";
                        noteWatch("generation started (late watchdog)");
                        armQuiet();
                    } else {
                        noteWatch("start signal not detected yet; still waiting");
                    }
                }
            }, 60000);
            deadlineTimer = setTimeout(function () {
                finish({ error: "response timeout" });
            }, deadlineMs);
        });
        promise.cancel = function () { if (cancelWait) cancelWait(); };
        return promise;
    }

  function composerText(el) {
    return el && (el.isContentEditable ? (el.innerText || el.textContent || "") : (el.value || ""));
  }

  function normalizedMessage(text) {
    return String(text || "").replace(/\u00a0/g, " ").replace(/[\t\r\n ]+/g, " ").trim();
  }

  // Submission confirmation must work for ANY provider DOM, not just ChatGPT.
  // Candidate user-turn nodes come from (in order): the adapter's optional
  // `user_message` selector, a small provider fallback list, and finally the
  // messages container's own children (covers simple pages like the demo).
  function userTurnNodes() {
    var selectors = [];
    if (S.user_message) selectors.push(S.user_message);
    selectors.push('[data-message-author-role="user"]');
    for (var m = 0; m < USER_MARKERS.length; m++) selectors.push(USER_MARKERS[m]);
    selectors.push('[data-testid*="user-message" i]');
    selectors.push('[class*="user-message" i]');
    selectors.push('[class*="userMessage"]');
    var out = [];
    var seen = [];
    for (var i = 0; i < selectors.length; i++) {
      var found = qAll(selectors[i]);
      for (var j = 0; j < found.length; j++) {
        if (seen.indexOf(found[j]) === -1) { seen.push(found[j]); out.push(found[j]); }
      }
    }
    if (!out.length && S.messages) {
      // Fallback: direct children of the messages container. Demo-style pages.
      var container = q(S.messages.split(",")[0].trim());
      var root = container && (container.closest("#messages") || container.parentElement || container);
      if (root && root.children) {
        for (var k = 0; k < root.children.length; k++) out.push(root.children[k]);
      }
    }
    return dropNested(out);
  }

  function editedByUser(node) {
    // Some providers mark user turns only by class; text equality is the final
    // arbiter in waitSubmission, so just filter obvious non-message nodes.
    return !!(node && (node.innerText || node.textContent));
  }

  function waitSubmission(input, text, baselineUserMessages, baselineAssistants, timeoutMs) {
    return new Promise(function (resolve) {
      var observer = null, timer = null, done = false;
      function finish(ok) {
        if (done) return;
        done = true;
        if (observer) observer.disconnect();
        if (timer) clearTimeout(timer);
        resolve(ok);
      }
      function currentTexts() {
        return userTurnNodes()
          .filter(editedByUser)
          .map(function (node) { return normalizedMessage(node.innerText || node.textContent || ""); });
      }
      function headTailMatch(turn, sent) {
        // Long or UI-collapsed turns differ from the exact sent text (editor
        // normalization, "Show more" truncation). Head+tail 120 chars of
        // normalized text is strong identity without full equality.
        if (turn.length <= 240 || sent.length <= 120) return false;
        return turn.slice(0, 120) === sent.slice(0, 120) && turn.slice(-120) === sent.slice(-120);
      }
      function assistantCountGrew() {
        return extractedLast().count > baselineAssistants;
      }
      function confirmed() {
        var sent = normalizedMessage(text);
        var texts = currentTexts();
        if (texts.length > baselineUserMessages.length) {
          for (var i = baselineUserMessages.length; i < texts.length; i++) {
            if (texts[i] === sent || headTailMatch(texts[i], sent)) return true;
          }
          // A new user turn exists but its text diverges: only accept via the
          // independent signals below, never on the click alone.
        }
        // Composer emptied AND (stop control visible OR an assistant turn
        // appeared): the provider accepted and reacted to the submission.
        if (input && normalizedMessage(composerText(input)) === "" && (stopVisible() || assistantCountGrew())) {
          return true;
        }
        return false;
      }
      function check() { if (confirmed()) finish(true); }
      if (document.body) {
        observer = new MutationObserver(function () {
          // Same reason as the reply watch: invalidate the extraction memo so a
          // single mutation batch is not judged on the previous snapshot.
          DOM_VERSION += 1;
          check();
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
      }
      timer = setTimeout(function () { finish(confirmed()); }, timeoutMs);
      check();
    });
  }

  function findSendButton(input) {
    var selectors = [
      S.send_button,
      '[data-testid="send-button"]',
      // ChatGPT's conversation layout renders the submit control as
      // button#composer-submit-button (the landing page uses send-button).
      '#composer-submit-button',
      '[data-testid="composer-submit-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Send"]'
    ].filter(Boolean);
    for (var i = 0; i < selectors.length; i++) {
      var candidates = qAll(selectors[i]);
      for (var j = 0; j < candidates.length; j++) {
        if (visible(candidates[j]) && !candidates[j].disabled) return candidates[j];
      }
    }
    // Generic structural fallback for every provider: a unique enabled submit
    // button inside the composer's own form. Works for Claude/Gemini/generic
    // pages without inventing labels, and cannot target an unrelated control.
    if (input && typeof input.closest === "function") {
      var form = input.closest("form");
      if (form && typeof form.querySelectorAll === "function") {
        var submitButtons = Array.prototype.filter.call(form.querySelectorAll('button[type="submit"]'), function (button) {
          return visible(button) && !button.disabled;
        });
        if (submitButtons.length === 1) return submitButtons[0];
      }
    }
    return null;
  }

  // Resolve once the provider is not generating anymore. ChatGPT keeps the
  // composer's Send control disabled while a reply is still finalizing, so an
  // agent's next turn (a protocol reminder right after the reply) could find no
  // enabled button and abort. Mutation-driven, bounded, never a polling loop.
  function waitForComposerIdle(timeoutMs) {
    return new Promise(function (resolve) {
      if (!stopVisible()) { resolve(true); return; }
      var observer = null, timer = null, done = false;
      function finish(idle) {
        if (done) return;
        done = true;
        if (observer) observer.disconnect();
        if (timer) clearTimeout(timer);
        resolve(idle);
      }
      if (document.body) {
        observer = new MutationObserver(function () {
          if (!stopVisible()) finish(true);
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      }
      timer = setTimeout(function () { finish(false); }, timeoutMs);
    });
  }

  // A freshly mounted provider webview can fire its first "page ready" before
  // the real document commits; a click placed on that early DOM is destroyed by
  // the reload that follows (observed live: page ready 1.1s AFTER the click, the
  // submission silently vanished). Wait for a settled document before typing.
  function pageSettle(timeoutMs) {
    return new Promise(function (resolve) {
      var done = false, timer = null;
      function finish() {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        if (typeof document.removeEventListener === "function") document.removeEventListener("load", finish);
        resolve(true);
      }
      // The fallback timer is armed FIRST and in every branch. The rAF path
      // previously returned without a timer, and rAF is fully suspended when
      // the provider webview is hidden during an active task (Chromium does
      // not run animation frames for hidden documents) — so on a follow-up
      // submission the settle promise never resolved, the send RPC was
      // cancelled at 25s, and SEND_IN_FLIGHT stayed latched (live: rpc r9
      // stalled inside pageSettle after "idle after 4ms" for the full wall).
      timer = setTimeout(finish, timeoutMs);
      if (document.readyState === "complete" && typeof requestAnimationFrame === "function") {
        requestAnimationFrame(function () { finish(); });
        return;
      }
      if (typeof document.addEventListener === "function") document.addEventListener("load", finish);
    });
  }

  // Real DOM nodes expose isConnected; minimal host stubs may not. An absent
  // value means "cannot tell", which must not be read as "detached".
  function stillAttached(node) {
    return !!node && (node.isConnected === undefined || node.isConnected === true);
  }

  function editorText(el) {
    if (!el) return "";
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el.value || "";
    return el.innerText || el.textContent || "";
  }

  // Does the composer still hold (at least the head of) the prompt we composed?
  // Long prompts are compared by their first 200 normalized characters: the
  // editor may wrap or strip trailing whitespace, but losing the head means the
  // page re-rendered and a click would submit something else.
  function editorContains(el, text) {
    var wanted = normalizedMessage(text);
    if (!wanted) return false;
    var current = normalizedMessage(editorText(el));
    return current.indexOf(wanted.slice(0, 200)) !== -1;
  }

  function waitForSendButton(timeoutMs) {
    return new Promise(function (resolve) {
      var observer = null, timer = null, done = false;
      function finish(button) {
        if (done) return;
        done = true;
        if (observer) observer.disconnect();
        if (timer) clearTimeout(timer);
        resolve(button);
      }
      function check() { var button = findSendButton(findComposer().element); if (button) finish(button); }
      if (document.body) {
        observer = new MutationObserver(function () {
          DOM_VERSION += 1;
          check();
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      }
      timer = setTimeout(function () { finish(null); }, timeoutMs);
      check();
    });
  }

  // ---- extraction -----------------------------------------------------------
  function stripUiNoise(text) {
    if (!text) return "";
    // Strip citation tokens FIRST: providers often render "Copy 【cite】" on
    // one line, and the copy-control filter below would not match while the
    // citation is still attached — leaving a bare "Copy" in the reply the
    // agent then parses.
    return text
      .replace(/【[^】]{0,64}】/g, "") // citation tokens
      .split("\n")
      .filter(function (line) { return !/^\s*(copy|copy code|copied!?)\s*$/i.test(line); })
      .join("\n")
      .trim();
  }
  function getLastAssistant() {
    // One extractor for every path, so diagnostics and the completion watch
    // can never disagree about what the latest reply is.
    return extractedLast(true).text;
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
      // Sanitized diagnostics for the sign-in / "can't reach the page" card and
      // for support reports: EXISTENCE and COUNTS only, never page text.
      var markers = {
        configured_logged_in: S.logged_in ? found(S.logged_in) : null,
        configured_logged_out: S.logged_out ? found(S.logged_out) : null,
        // ChatGPT authenticated markers
        profile_button: found('[data-testid="profile-button"]'),
        profile_menu_aria: found('[aria-label="Open profile menu"]'),
        account_menu_button: found('[data-testid="account-menu-button"]'),
        accounts_profile_button: found('[data-testid="accounts-profile-button"]'),
        aria_account: found('[aria-label="Account"]'),
        model_switcher_dropdown: found('[data-testid="model-switcher-dropdown"]'),
        model_switcher: found('[data-testid="model-switcher"]'),
        avatar_image: found('img[alt*="profile" i], img[alt*="avatar" i]'),
        // ChatGPT logged-out markers
        login_link_auth: found('a[href*="/auth/login"]'),
        login_button_testid: found('a[data-testid="login-button"]'),
        welcome_login_button: found('button[data-testid="welcome-login-button"]'),
        login_button_generic: found('[data-testid="login-button"]'),
        google_oauth_link: found('a[href*="accounts.google.com"]'),
        auth0_link: found('a[href*="auth0.openai.com"]'),
        // Generic markers
        new_chat_link: found('a[aria-label="New chat"], button[aria-label="New chat"]'),
        sidebar_nav: found('nav'),
        user_turns: userTurnNodes().length,
        assistant_turns: assistantTurnNodes().length,
        stop_button_configured: !!S.stop_button,
        stop_button_visible: stopVisible()
      };
      return {
        url: location.href,
        logged_in: r.state === "logged_in",
        login: r,
        input_found: !!findComposer().element,
        input_selector: findComposer().selector,
        user_message_selector: S.user_message || "(built-in fallbacks)",
        ready_state: document.readyState,
        send_button_found: !!findSendButton(findComposer().element),
        messages_found: messages,
        // Which reply-detection family matched (metadata only). "none" means
        // the page layout is not recognised — the reply would be invisible to
        // Neelima until a layout is added.
        reply_layout: replyLayout(),
        // Structure of the newest content blocks (tags, attribute names, text
        // LENGTHS). Lets an unrecognised live layout be fixed from a report
        // instead of guessing selectors.
        reply_dom: replyDomReport(),
        // Diagnostics for the reply-capture pipeline (metadata only).
        visibility_state: document.visibilityState,
        visibility_override_active: document.visibilityState === "visible" && document.hidden === false,
        watch: {
          attached_target: WATCH_STATS.attached_target,
          connected: WATCH_STATS.connected,
          callbacks: WATCH_STATS.callbacks,
          active: !!ACTIVE_WATCH
        },
        turns: { users: userTurnNodes().length, assistants: assistantTurnNodes().length },
        last_assistant_len: (getLastAssistant() || "").length,
        ms_since_send: LAST_SEND_AT ? (Date.now() - LAST_SEND_AT) : null,
        markers: markers
      };
    },
    // One-shot reply capture for the Rust safety net: reads the CURRENT reply
    // candidate without arming any watch and without ever resending.
    capture_reply: function () {
      var cur = extractedLast(true);
      return {
        text: cur.text || "",
        has_reply: cur.has_reply === true,
        request_id: ACTIVE_REQUEST_ID,
        assistant_count: cur.count,
        layout: replyLayout(),
        dom: replyDomReport(),
        // Metadata only: lets the Rust backstop tell "still streaming" from
        // "finished", so it never delivers half a reply as a complete one.
        stop_visible: stopVisible(),
        user_count: userTurnNodes().length,
        visibility_state: document.visibilityState,
        watch: {
          attached_target: WATCH_STATS.attached_target,
          connected: WATCH_STATS.connected,
          callbacks: WATCH_STATS.callbacks
        }
      };
    },
    // Tear down the page-side completion watch (cancel/timeout/superseded
    // send). Never touches the prompt, the composer, or the provider UI.
    cancel_response: function () {
      var watch = ACTIVE_WATCH;
      ACTIVE_WATCH = null;
      if (watch && typeof watch.cancel === "function") {
        try { watch.cancel({ from: "request" }); } catch (e) { /* already finished */ }
        return { cancelled: true };
      }
      return { cancelled: false };
    },
    is_logged_in: function () { return evalLogin().state === "logged_in"; },

    // Explicit correlation binding. Rust calls this immediately before
    // send_message so every push from this round carries the request ID. It
    // runs in the same runtime instance that will receive send_message, so it
    // cannot be missed by an argument-parse or injection-order change.
    set_request: function (a) {
      var cfg = parseArg(a);
      if (cfg && cfg.request_id) ACTIVE_REQUEST_ID = String(cfg.request_id);
      return { request_id: ACTIVE_REQUEST_ID };
    },

    new_chat: function () {
      var btn = S.new_chat ? q(S.new_chat) : null;
      if (btn) { btn.click(); return { clicked: true }; }
      return { clicked: false };
    },

    send_message: function (a) {
      // One submission at a time. A second concurrent call would type into the
      // same composer and could click twice, so it is refused without touching
      // the page; the caller can retry after the first resolves.
      if (SEND_IN_FLIGHT) {
        return { error_type: "busy", error: "a prompt is already being submitted; wait for that submission to resolve" };
      }
      SEND_IN_FLIGHT = true;
      var done = function (value) { SEND_IN_FLIGHT = false; return value; };
      var failed = function (error) { SEND_IN_FLIGHT = false; throw error; };
      try {
      var cfg = parseArg(a);
      var sendT0 = Date.now();
      // Deadline contract (Phase 3O checkpoint 3): the backend passes its own
      // RPC budget minus a safety margin. Every pre-click stage shares that
      // deadline instead of stacking full worst cases (~50s), which used to
      // outlive the RPC budget — the late result was discarded and
      // SEND_IN_FLIGHT stayed latched, so the next task's cold-start send was
      // refused with "a prompt is already being submitted".
      var budgetMs = cfg && Number(cfg.budget_ms) > 0 ? Number(cfg.budget_ms) : 23000;
      var sendDeadline = sendT0 + budgetMs;
      var WAIT_SUBMISSION_MS = 8000;
      function timeLeft() { return sendDeadline - Date.now(); }
      // A stage never outlives the shared deadline; 0 is a legal (immediate)
      // budget, and every helper resolves on a 0 timer rather than hanging.
      function stageBudget(max) { return Math.max(0, Math.min(max, timeLeft())); }
      // Bind every push from this send to the backend's correlation ID BEFORE
      // the first phase is posted, so a milestone can never carry the previous
      // turn's id and be rejected by the request registry.
      if (cfg.request_id) ACTIVE_REQUEST_ID = String(cfg.request_id);
      sendPhase("send begin rid=" + (cfg.request_id ? String(cfg.request_id).slice(-8) : "MISSING"));
      var found = findComposer();
      var input = found.element;
      if (!input) return done({ error_type: "page_changed", error: "the provider message composer was not found. Expected a supported editable prompt field (last checked: " + found.selector + "). Open the sign-in window to refresh it, or choose a configured API/local model." });
      if (!visible(input) || !editable(input)) return done({ error_type: "page_changed", error: "the detected message composer is not visible or editable; refresh the provider window or choose a configured API/local model" });
      LAST_SENT_TEXT = normalizedMessage(cfg.text || "");
      var beforeUsers = userTurnNodes()
        .filter(editedByUser)
        .map(function (node) { return normalizedMessage(node.innerText || node.textContent || ""); });
      var wanted = String(cfg.text || "");
      // Each submission is fired through exactly one path so a stale-node
      // recovery cannot forget the response watch or the click accounting.
      function fire(sendBtn, inputEl) {
        // The click must only happen when the confirmation window still fits
        // inside the shared deadline. Clicking with the RPC budget nearly
        // spent used to lose the submission: the result was discarded by the
        // cancelled RPC, the prompt had gone out, and the outcome became
        // unknowable. Nothing has been typed into the conversation yet, so
        // refusing here is safe and retrying later is legitimate.
        if (timeLeft() < WAIT_SUBMISSION_MS + 500) {
          sendPhase("submission budget exhausted before the click after " + (Date.now() - sendT0) + "ms");
          return Promise.resolve({
            error_type: "deadline",
            error: "the prompt was NOT submitted: the submission deadline ran out while the provider page was settling; nothing was clicked, so retrying once the page is idle is safe"
          });
        }
        var baselineAssistants = extractedLast().count;
        LAST_SEND_AT = Date.now();
        var responseWatch = waitResponse(cfg);
        sendBtn.click();
        sendPhase("clicked after " + (Date.now() - sendT0) + "ms");
        return waitSubmission(inputEl, wanted, beforeUsers, baselineAssistants, WAIT_SUBMISSION_MS).then(function (confirmed) {
          sendPhase("submission confirmed=" + confirmed + " after " + (Date.now() - sendT0) + "ms");
          if (!confirmed) {
            // The click happened but the provider did not expose a matching new
            // user turn in time. The outcome is UNKNOWN, so:
            //  - never retry (a retry could double-submit),
            //  - keep the response watch armed: if the prompt did submit, the
            //    assistant reply still pushes and the task continues normally,
            //  - report the uncertainty so Rust can bound its wait and say so.
            return {
              sent: true,
              submission_confirmed: false,
              error_type: "send_unconfirmed",
              warning: "the provider did not confirm the prompt entered its conversation; awaiting a response without resending"
            };
          }
          return { sent: true, submission_confirmed: true };
        });
      }

      return waitForComposerIdle(stageBudget(15000)).then(function () {
        sendPhase("idle after " + (Date.now() - sendT0) + "ms");
        // Nothing has been typed or clicked yet, so waiting here cannot lose a
        // submission; it only avoids composing into a document about to reload.
        return pageSettle(stageBudget(5000));
      }).then(function () {
        sendPhase("page settled after " + (Date.now() - sendT0) + "ms");
        // The composer node can be re-rendered while the reply finishes.
        var again = findComposer();
        if (again.element) input = again.element;
        if (!input) {
          return { error_type: "page_changed", error: "the provider message composer disappeared before the prompt could be composed; refresh the provider window or choose a configured API/local model" };
        }
        setEditorText(input, wanted, A.input && A.input.kind);
        sendPhase("text set " + (Date.now() - sendT0) + "ms");
        return waitForSendButton(stageBudget(8000));
      }).then(function (send) {
        if (!send) {
          // The SPA can re-render the composer and drop the inserted text; a
          // second, still-unclicked attempt is safe (nothing was submitted).
          sendPhase("send button NOT ready, re-applying text after " + (Date.now() - sendT0) + "ms");
          setEditorText(input, wanted, A.input && A.input.kind);
          return waitForSendButton(stageBudget(8000));
        }
        return send;
      }).then(function (send) {
        if (!send) {
          sendPhase("send button NOT ready after " + (Date.now() - sendT0) + "ms");
          // Nothing was clicked: the prompt was definitely NOT submitted.
          return { error_type: "page_changed", error: "the prompt field is available but no enabled supported Send button appeared; refresh the provider page or use a configured API/local model" };
        }
        sendPhase("send button ready after " + (Date.now() - sendT0) + "ms");
        if (!stillAttached(send) || !stillAttached(input)) {
          // The document swapped the button/composer after they were resolved.
          // Nothing has been clicked, so re-composing on the fresh nodes is safe;
          // this is the second half of the cold-start guard.
          sendPhase("stale nodes before click after " + (Date.now() - sendT0) + "ms");
          return pageSettle(stageBudget(4000)).then(function () {
            var fresh = findComposer();
            if (!stillAttached(fresh.element)) return null;
            input = fresh.element;
            setEditorText(input, wanted, A.input && A.input.kind);
            return waitForSendButton(stageBudget(6000));
          }).then(function (freshSend) {
            if (!stillAttached(freshSend)) {
              sendPhase("no send button on the settled document");
              return { error_type: "page_changed", error: "the provider page reloaded while the prompt was being prepared and no enabled supported Send button appeared afterwards; the prompt was not sent" };
            }
            if (editorText(input).trim() === "" || !editorContains(input, wanted)) {
              sendPhase("composer text missing after reload");
              return { error_type: "page_changed", error: "the prompt field lost the composed text before submission; the prompt was not sent" };
            }
            return fire(freshSend, input);
          });
        }
        if (editorText(input).trim() === "" || !editorContains(input, wanted)) {
          // The button exists but the composer no longer holds this prompt
          // (page re-render). Clicking would submit the wrong thing.
          sendPhase("composer text missing after " + (Date.now() - sendT0) + "ms");
          return { error_type: "page_changed", error: "the prompt field lost the composed text before submission; the prompt was not sent" };
        }
        // Re-baseline the response watch at the INSTANT before the click: the
        // assistant count and texts are captured here so anything that appeared
        // while the send button was being located counts as pre-existing.
        // The watch observes document.body, so an SPA container swap after
        // this point cannot deafen it.
        return fire(send, input);
      }).then(done, failed);
      } catch (e) {
        SEND_IN_FLIGHT = false;
        throw e;
      }
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
