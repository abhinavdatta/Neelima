const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const { join } = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const runtime = readFileSync(join(__dirname, "../src/adapter_runtime.js"), "utf8");
const chatgpt = require("../assets/adapter-chatgpt.json");

function createPage({ readyState = "complete", href = "https://chatgpt.com/", composer = false } = {}) {
  const messages = [];
  const timers = new Map();
  let timerId = 0;
  const input = {
    tagName: "DIV",
    isContentEditable: true,
    disabled: false,
    readOnly: false,
    innerText: "",
    textContent: "",
    getClientRects: () => [{}],
  };
  const body = { style: {}, addEventListener() {} };
  const main = {};
  const document = {
    readyState,
    body,
    activeElement: null,
    querySelector(selector) {
      if (selector === "main") return main;
      if (selector.includes("prompt-textarea") && composer) return input;
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
  };
  class MutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() {}
    disconnect() {}
  }
  const window = {
    __LB_ADAPTER__: chatgpt,
    __LB_NONCE__: "test-nonce",
    __TAURI_INTERNALS__: {
      invoke(_command, args) {
        const message = JSON.parse(args.msg);
        messages.push(message);
        return Promise.resolve(null);
      },
    },
    addEventListener() {},
    getComputedStyle() { return { display: "block", visibility: "visible", opacity: "1" }; },
  };
  const history = { pushState() {}, replaceState() {} };
  const context = {
    window,
    document,
    history,
    location: { href },
    MutationObserver,
    URL,
    Promise,
    JSON,
    Array,
    String,
    Date,
    RegExp,
    setTimeout(callback, delay = 0) {
      const id = ++timerId;
      timers.set(id, callback);
      if (delay === 0) callback();
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    console,
  };
  runInNewContext(runtime, context);
  return { window, messages, timers };
}

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => global.setImmediate(resolve));
}

function loginState(messages) {
  return messages.filter((message) => message.t === "login_state").at(-1);
}

test("ChatGPT adapter distinguishes loading, sign-in, challenge, and chat composer states", async () => {
  const loading = createPage({ readyState: "interactive" });
  await settle();
  assert.equal(loginState(loading.messages).state, "loading");

  const signedOut = createPage({ href: "https://chatgpt.com/auth/login" });
  await settle();
  assert.equal(loginState(signedOut.messages).state, "logged_out");

  const challenge = createPage({ href: "https://chatgpt.com/cdn-cgi/challenge" });
  await settle();
  assert.equal(loginState(challenge.messages).state, "challenge");

  const authenticated = createPage({ composer: true });
  await settle();
  assert.equal(loginState(authenticated.messages).state, "logged_in");
});

test("missing ChatGPT composer is actionable and cannot report a sent prompt", async () => {
  const page = createPage();
  await settle();
  page.window.__LB__.call("send_message", JSON.stringify({ text: "create a file" }), "send", "test-nonce");
  await settle();
  const response = page.messages.find((message) => message.t === "rpc_result" && message.id === "send");
  assert.ok(response);
  const reply = JSON.parse(response.v);
  assert.equal(reply.ok, true);
  assert.equal(reply.value.error_type, "page_changed");
  assert.match(reply.value.error, /open the sign-in window to refresh it/i);
  assert.notEqual(reply.value.sent, true);
});
