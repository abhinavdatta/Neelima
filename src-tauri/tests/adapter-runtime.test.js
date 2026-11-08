const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const { join } = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const runtime = readFileSync(join(__dirname, "../src/adapter_runtime.js"), "utf8");
const chatgpt = require("../assets/adapter-chatgpt.json");

function createPage({
  adapter = chatgpt,
  readyState = "complete",
  href = "https://chatgpt.com/",
  composer = false,
  profileMarker = false,
  loggedOutMarker = false,
  onSend = null,
  sendButtonLabel = "Send prompt",
  sendButtonTestId = "send-button",
  formSubmit = false,
} = {}) {
  const messages = [];
  const timers = new Map();
  const observers = new Set();
  let timerId = 0;
  const sendButton = {
    disabled: false,
    offsetParent: {},
    type: formSubmit ? "submit" : "button",
    getClientRects: () => [{}],
    getAttribute(name) {
      if (name === "aria-label") return sendButtonLabel;
      if (name === "data-testid") return sendButtonTestId;
      return null;
    },
    click() { onSend?.({ input, users, assistantMessages, notify, setStop }); },
  };
  const form = {
    querySelectorAll(selector) {
      return formSubmit && selector === 'button[type="submit"]' ? [sendButton] : [];
    },
  };
  const input = {
    tagName: "TEXTAREA",
    isContentEditable: false,
    disabled: false,
    readOnly: false,
    _value: "",
    focus() {},
    dispatchEvent() {},
    textContent: "",
    getClientRects: () => [{}],
    closest(selector) { return formSubmit && selector === "form" ? form : null; },
  };
  const body = { style: {}, addEventListener() {} };
  const users = [];
  const assistantMessages = [];
  const main = { querySelectorAll() { return []; } };
  let stopOn = false;
  const stopNode = { getClientRects: () => [{}] };
  const setStop = (on) => { stopOn = !!on; };
  function notify() { for (const observer of observers) observer.callback([]); }
  Object.defineProperty(input, "value", { get() { return this._value; }, set(value) { this._value = value; } });
  const textareaProto = {};
  Object.defineProperty(textareaProto, "value", { set(value) { this._value = value; } });
  const document = {
    readyState,
    body,
    activeElement: null,
    querySelector(selector) {
      if (selector === "main") return main;
      if (
        (profileMarker && selector.includes("Open profile menu")) ||
        (profileMarker && selector.includes('[data-testid="profile-button"]'))
      ) return { getClientRects: () => [{}] };
      if (
        loggedOutMarker &&
        (selector === chatgpt.selectors.logged_out || selector.includes("login-button"))
      ) return { getClientRects: () => [{}] };
      if (selector === chatgpt.selectors.stop_button && stopOn) return stopNode;
      if (selector.includes("prompt-textarea") && composer) return input;
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes('data-message-author-role="user"')) return users;
      if (
        (sendButtonTestId && selector.includes('[data-testid="send-button"]')) ||
        (sendButtonLabel && selector.includes(`[aria-label="${sendButtonLabel}"]`))
      ) return [sendButton];
      if (selector === chatgpt.selectors.messages) return assistantMessages;
      return [];
    },
    addEventListener() {},
    removeEventListener() {},
  };
  class MutationObserver {
    constructor(callback) { this.callback = callback; observers.add(this); }
    observe() {}
    disconnect() { observers.delete(this); }
  }
  const window = {
    __LB_ADAPTER__: adapter,
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
    crypto: { randomUUID: () => "runtime-session-1" },
  };
  const history = { pushState() {}, replaceState() {} };
  let now = 0;
  const context = {
    window,
    document,
    history,
    location: { href },
    MutationObserver,
    HTMLTextAreaElement: { prototype: textareaProto },
    HTMLInputElement: { prototype: {} },
    Event: class { constructor(type) { this.type = type; } },
    URL,
    Promise,
    JSON,
    Array,
    String,
    Date,
    RegExp,
    setTimeout(callback, delay = 0) {
      const id = ++timerId;
      timers.set(id, { callback, at: now + (delay || 0) });
      if (!delay) callback();
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    console,
  };
  // Virtual clock: advancing by N fires every timer due within that span,
  // including timers the callbacks arm while the sweep is running. Firing by
  // exact delay only would make multi-window completion tests (quiet, re-arm,
  // confirm) impossible to express.
  runInNewContext(runtime, context);
  function runTimers(delay) {
    const target = now + delay;
    for (;;) {
      const due = [...timers]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      timers.delete(id);
      // Fire in schedule order so a callback that re-arms a timer (the quiet
      // re-confirmation window) lands relative to ITS own due time.
      now = Math.max(now, timer.at);
      timer.callback();
    }
    now = target;
  }
  return { window, messages, timers, users, assistantMessages, input, notify, runTimers, setStop };
}

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => global.setImmediate(resolve));
}

function loginState(messages) {
  return messages.filter((message) => message.t === "login_state").at(-1);
}

test("ChatGPT adapter distinguishes loading, sign-in, challenge, and authenticated chat states", async () => {
  const loading = createPage({ readyState: "interactive" });
  await settle();
  assert.equal(loginState(loading.messages).state, "loading");

  const signedOut = createPage({ href: "https://chatgpt.com/auth/login" });
  await settle();
  assert.equal(loginState(signedOut.messages).state, "logged_out");

  const challenge = createPage({ href: "https://chatgpt.com/cdn-cgi/challenge" });
  await settle();
  assert.equal(loginState(challenge.messages).state, "challenge");

  const composerOnly = createPage({ composer: true });
  await settle();
  assert.equal(loginState(composerOnly.messages).state, "unknown");
  assert.match(loginState(composerOnly.messages).reason, /no authenticated account marker/i);

  const signedOutWithComposer = createPage({ composer: true, loggedOutMarker: true });
  await settle();
  assert.equal(loginState(signedOutWithComposer.messages).state, "logged_out");

  const authenticated = createPage({ composer: true, profileMarker: true });
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

async function sendOnMockPage(page, text = "make a file") {
  page.window.__LB__.call("send_message", JSON.stringify({ text }), "send", "test-nonce");
  await settle();
}

function sendReply(page) {
  return page.messages.filter((message) => message.t === "rpc_result" && message.id === "send").map((message) => JSON.parse(message.v).value).at(-1);
}

// The current runtime's send/reply chain resolves across sequential async
// stages (idle wait → page settle → text → button → click → submission
// confirmation → reply watch). Each stage arms its successor timer only after
// the previous clock sweep has ended: promise continuations are microtasks,
// which do not run while a synchronous sweep loop is on the stack — and the
// sweep's final `now = target` jump desynchronizes any timer armed after it.
// A single runTimers window therefore cannot advance the whole chain. This
// mirrors the real provider page, which advances stage by stage over real
// time. `drain()` advances the virtual clock in bounded rounds with a
// microtask flush between rounds. It never retries a submission and never
// fabricates state; it only advances the clock and flushes microtasks, and it
// stops as soon as `stopWhen(page)` holds (or reports false after the cap).
async function drain(page, stopWhen, { rounds = 12, window = 8000 } = {}) {
  for (let i = 0; i < rounds; i += 1) {
    await settle();
    if (stopWhen(page)) return true;
    page.runTimers(window);
  }
  await settle();
  return !!stopWhen(page);
}
const sendSettled = (page) => page.messages.some((m) => m.t === "rpc_result" && m.id === "send");
const replyPushed = (page) => page.messages.some((m) => m.t === "assistant_message");
const clickSeen = (page) => page.messages.some((m) => m.t === "watch_state" && /clicked after /.test(m.note));
const watchCompleted = (page) => page.messages.some((m) => m.t === "watch_state" && m.note === "completed");
const providerError = (page) => page.messages.some((m) => m.t === "response_error");

test("an empty composer without a new matching user message is not submission confirmation", async () => {
  let clickCount = 0;
  const page = createPage({ composer: true, onSend: ({ input }) => { clickCount += 1; input.value = ""; } });
  await sendOnMockPage(page);
  await drain(page, sendSettled);
  assert.equal(sendReply(page).error_type, "send_unconfirmed");
  assert.equal(sendReply(page).sent, true);
  assert.equal(clickCount, 1, "unconfirmed prompt is never retried");
});

test("submission is confirmed only after an exact matching new user message appears", async () => {
  const page = createPage({ composer: true, onSend: ({ users, notify }) => { users.push({ innerText: "make a file", textContent: "make a file" }); notify(); } });
  await sendOnMockPage(page);

  await drain(page, sendSettled);

  assert.equal(sendReply(page).sent, true);
});

test("ChatGPT send button supports its updated accessible label", async () => {
  const page = createPage({
    composer: true,
    sendButtonLabel: "Send message",
    sendButtonTestId: "",
    onSend: ({ users, notify }) => { users.push({ innerText: "make a file", textContent: "make a file" }); notify(); },
  });
  await sendOnMockPage(page);

  await drain(page, sendSettled);

  assert.equal(sendReply(page).sent, true);
});

test("ChatGPT can use the unique submit button in the composer form", async () => {
  const page = createPage({
    composer: true,
    sendButtonLabel: "",
    sendButtonTestId: "",
    formSubmit: true,
    onSend: ({ users, notify }) => { users.push({ innerText: "make a file", textContent: "make a file" }); notify(); },
  });
  await sendOnMockPage(page);

  await drain(page, sendSettled);

  assert.equal(sendReply(page).sent, true);
});

test("delayed matching user-message insertion confirms submission", async () => {
  const page = createPage({ composer: true, onSend: ({ input }) => { input.value = ""; } });
  await sendOnMockPage(page);
  page.users.push({ innerText: "make a file", textContent: "make a file" });
  page.notify();

  await drain(page, sendSettled);

  assert.equal(sendReply(page).sent, true);
});

test("a new assistant response is pushed once after a stable quiet snapshot", async () => {
  const page = createPage({ composer: true, onSend: ({ users, assistantMessages, notify }) => {
    users.push({ innerText: "make a file", textContent: "make a file" });
    assistantMessages.push({ innerText: "Done with the requested work.", textContent: "Done with the requested work.", querySelectorAll() { return []; } });
    notify();
  } });
  await sendOnMockPage(page);
  // Two quiet windows: no stop control was ever observed, so completion needs
  // a second independent confirmation (a stream pause must not complete).
  await drain(page, replyPushed);
  const replies = page.messages.filter((message) => message.t === "assistant_message");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, "Done with the requested work.");
  assert.equal(replies[0].runtime_id, "runtime-session-1");
});

	test("a quiet page with no new assistant message times out without a false completion", async () => {
		  const page = createPage({ composer: true });
		  page.window.__LB__.call("wait_response", JSON.stringify({ timeout_ms: 1000, quiet_ms: 10 }), "wait", "test-nonce");
		  page.runTimers(1000);
		  await settle();
		  const result = page.messages.filter((message) => message.t === "rpc_result" && message.id === "wait").map((message) => JSON.parse(message.v).value).at(-1);
		  assert.equal(result.error, "response timeout");
		  assert.equal(page.messages.filter((message) => message.t === "assistant_message").length, 0);
		});

	test("attribute-only mutation storms never block completion of a finished reply", async () => {
		// Cross-provider root cause of the silent "response timeout": providers
		// mutate attributes (animations, aria-busy, class churn) forever. The
		// completion watch must complete on content, not on mutation silence.
		const page = createPage({ composer: true, onSend: ({ users, assistantMessages, notify }) => {
			users.push({ innerText: "make a file", textContent: "make a file" });
			assistantMessages.push({ innerText: "READY", textContent: "READY", querySelectorAll() { return []; } });
			notify();
		} });
		await sendOnMockPage(page);
		// Hammer the observer with mutations that carry NO content change.
		for (let i = 0; i < 20; i += 1) page.notify();
		await drain(page, replyPushed);
		const replies = page.messages.filter((message) => message.t === "assistant_message");
		assert.equal(replies.length, 1, "exactly one completion push despite the storm");
		assert.equal(replies[0].text, "READY");
	});

	test("streamed replies push once with the final text after the quiet window", async () => {
		const page = createPage({ composer: true, onSend: ({ users, assistantMessages, notify }) => {
			users.push({ innerText: "make a file", textContent: "make a file" });
			assistantMessages.push({ innerText: "wor", textContent: "wor", querySelectorAll() { return []; } });
			notify();
		} });
		await sendOnMockPage(page);
await drain(page, clickSeen);
// Stream continues before the quiet window elapses.
		const node = page.assistantMessages.at(-1);
		node.innerText = "working on it";
		node.textContent = "working on it";
		page.notify();
		page.runTimers(2000); // content changed since arm -> re-arm, no push yet
		await settle();
		assert.equal(page.messages.filter((m) => m.t === "assistant_message").length, 0, "mid-stream content must not complete");
		page.runTimers(4000); // stable twice (no stop control seen) -> complete
		await settle();
		const replies = page.messages.filter((message) => message.t === "assistant_message");
		assert.equal(replies.length, 1, "one push for the whole stream");
		assert.equal(replies[0].text, "working on it");
		const previews = page.messages.filter((message) => message.t === "assistant_partial");
		assert.ok(previews.length >= 1, "streaming previews are emitted");
		assert.ok(previews.every((m) => m.request_id === replies[0].request_id), "previews share the request ID");
		assert.ok(previews.every((m) => typeof m.text === "string" && m.text.length > 0), "previews are non-empty");
	});

	test("an assistant reply that predates the submission is never reported as new", async () => {
		// Baseline rule: only a NEW assistant turn counts.
		const page = createPage({ composer: true, onSend: ({ users, notify }) => {
			users.push({ innerText: "make a file", textContent: "make a file" });
			notify();
		} });
		page.assistantMessages.push({ innerText: "stale older answer", textContent: "stale older answer", querySelectorAll() { return []; } });
		await sendOnMockPage(page);
		await drain(page, sendSettled);
		assert.equal(page.messages.filter((message) => message.t === "assistant_message").length, 0, "stale reply is not pushed");
		const waitResult = page.messages.filter((m) => m.t === "rpc_result" && m.id === "send").map((m) => JSON.parse(m.v).value).at(-1);
		assert.equal(waitResult.sent, true, "submission itself was confirmed");
	});

	test("completion pushes exactly once and later mutations cannot duplicate it", async () => {
		const page = createPage({ composer: true, onSend: ({ users, assistantMessages, notify }) => {
			users.push({ innerText: "make a file", textContent: "make a file" });
			assistantMessages.push({ innerText: "READY", textContent: "READY", querySelectorAll() { return []; } });
			notify();
		} });
		await sendOnMockPage(page);
		await drain(page, replyPushed);
		assert.equal(page.messages.filter((m) => m.t === "assistant_message").length, 1);
		for (let i = 0; i < 5; i += 1) page.notify();
		page.runTimers(2000);
		await settle();
		assert.equal(page.messages.filter((m) => m.t === "assistant_message").length, 1, "observer is torn down after completion");
	});

	test("sibling-anchor fallback detects a non-ChatGPT reply when assistant selectors go stale", async () => {
		// Generic providers may retain the legacy sibling fallback when message
		// selectors drift. ChatGPT intentionally fails closed without a turn ID.
		const fallbackAdapter = { ...chatgpt, id: "generic" };
		// Live root cause #2: provider renames message attributes; S.messages
		// matches nothing. The reply is detected as the sibling following the
		// confirmed user turn, so detection survives the rename.
		const page = createPage({ adapter: fallbackAdapter, composer: true, onSend: ({ users, notify }) => {
			const turn = { innerText: "make a file", textContent: "make a file", parentElement: {}, nextElementSibling: null };
			users.push(turn);
			notify();
		} });
		await sendOnMockPage(page);
await drain(page, sendSettled);
assert.equal(page.messages.filter((m) => m.t === "assistant_message").length, 0, "no reply node yet");
		// The provider creates the reply as the next sibling of the user turn.
		const turn = page.users.at(-1);
		turn.nextElementSibling = { innerText: "READY", textContent: "READY", querySelectorAll() { return []; } };
		page.notify();
		page.runTimers(2000); // fire: content changed vs armed "" -> re-arm
		await settle();
		assert.equal(page.messages.filter((m) => m.t === "assistant_message").length, 0, "first fire is a re-arm");
		page.runTimers(4000); // stable twice (no stop control seen) -> complete
		await settle();
		const replies = page.messages.filter((m) => m.t === "assistant_message");
		assert.equal(replies.length, 1, "fallback detection pushes the reply");
		assert.equal(replies[0].text, "READY");
	});

	test("a blind start signal no longer kills the watch at 60s; the deadline stays the honest bound", async () => {
		// Live root cause #3: with stale selectors the start watchdog used to
		// error out at 60s while the reply was already on the page.
		const page = createPage({ composer: true });
		page.window.__LB__.call("wait_response", JSON.stringify({ timeout_ms: 70000, quiet_ms: 10 }), "wait", "test-nonce");
		page.runTimers(60000); // old code finished here with an error
		await settle();
		assert.equal(
			page.messages.filter((m) => m.t === "rpc_result" && m.id === "wait").length,
			0,
			"60s watchdog must not finish the watch anymore"
		);
		page.runTimers(70000); // overall deadline
		await settle();
		const result = page.messages.filter((m) => m.t === "rpc_result" && m.id === "wait").map((m) => JSON.parse(m.v).value).at(-1);
		assert.equal(result.error, "response timeout");
	});

	test("the response watch reports metadata-only lifecycle diagnostics", async () => {
		const page = createPage({ composer: true, onSend: ({ users, assistantMessages, notify }) => {
			users.push({ innerText: "make a file", textContent: "make a file" });
			assistantMessages.push({ innerText: "READY", textContent: "READY", querySelectorAll() { return []; } });
			notify();
		} });
		await sendOnMockPage(page);
		await drain(page, watchCompleted);
		const states = page.messages.filter((m) => m.t === "watch_state");
		assert.ok(states.length >= 2, "start + completion transitions are reported");
		assert.ok(states.some((m) => m.note === "generation started"));
		assert.ok(states.some((m) => m.note === "completed"));
		// Metadata only: no reply text may leak through diagnostics.
		for (const s of states) {
			const serialized = JSON.stringify(s);
			assert.equal(serialized.includes("READY"), false, "watch_state never carries page text");
		}
	});

	test("provider chrome (copy control + citation token) never leaks into the pushed reply", async () => {
	// Live defect: the copy span renders as "Copy 【ref-1a2b3c】" on its own
	// line. Citations were stripped AFTER the copy-line filter, so the line
	// failed the filter and a bare "Copy" reached the agent.
	const page = createPage({ composer: true, onSend: ({ users, assistantMessages, notify }) => {
		users.push({ innerText: "make a file", textContent: "make a file" });
		assistantMessages.push({ innerText: "READY\nCopy 【ref-1a2b3c】", textContent: "READY\nCopy 【ref-1a2b3c】", querySelectorAll() { return []; } });
		notify();
	} });
	await sendOnMockPage(page);
	await drain(page, replyPushed);
	const replies = page.messages.filter((message) => message.t === "assistant_message");
	assert.equal(replies.length, 1);
	assert.equal(replies[0].text, "READY", "citation and copy control are stripped");
});

test("cancel_response tears down the watch so a late reply is never pushed", async () => {
	const page = createPage({ composer: true, onSend: ({ users, notify }) => {
		users.push({ innerText: "make a file", textContent: "make a file" });
		notify();
	} });
	await sendOnMockPage(page);
await drain(page, sendSettled);
page.window.__LB__.call("cancel_response", JSON.stringify(null), "cancel", "test-nonce");
	await settle();
	const cancelReply = page.messages.find((m) => m.t === "rpc_result" && m.id === "cancel");
	assert.equal(JSON.parse(cancelReply.v).value.cancelled, true);
	// The provider finishes generating AFTER the cancellation.
	page.assistantMessages.push({ innerText: "READY", textContent: "READY", querySelectorAll() { return []; } });
	page.notify();
	page.runTimers(4000);
	await settle();
	assert.equal(page.messages.filter((m) => m.t === "assistant_message").length, 0, "no push after cancel");
});

test("a superseding send cancels the previous watch and only the new request pushes", async () => {
	const page = createPage({ composer: true, onSend: ({ users, notify }) => {
		users.push({ innerText: "make a file", textContent: "make a file" });
		notify();
	} });
	await sendOnMockPage(page);
await drain(page, sendSettled);
// Second send starts while the first watch is still armed.
	page.window.__LB__.call("send_message", JSON.stringify({ text: "make a file", request_id: "req-second" }), "send2", "test-nonce");
	await settle();
	// The reply to the FIRST prompt appears late, then a second reply.
	page.assistantMessages.push({ innerText: "first answer", textContent: "first answer", querySelectorAll() { return []; } });
	page.notify();
	page.assistantMessages.push({ innerText: "second answer", textContent: "second answer", querySelectorAll() { return []; } });
	page.notify();
	page.runTimers(6000);
	await settle();
	const replies = page.messages.filter((m) => m.t === "assistant_message");
	assert.equal(replies.length, 1, "exactly one completion for the live watch");
	assert.equal(replies[0].request_id, "req-second");
});

test("a second concurrent send is refused without a second click", async () => {
	let clickCount = 0;
	const page = createPage({ composer: true, onSend: ({ input }) => { clickCount += 1; input.value = ""; } });
	page.window.__LB__.call("send_message", JSON.stringify({ text: "one" }), "sendA", "test-nonce");
	await drain(page, () => clickCount === 1);
	page.window.__LB__.call("send_message", JSON.stringify({ text: "two" }), "sendB", "test-nonce");
	await settle();
	const second = page.messages.find((m) => m.t === "rpc_result" && m.id === "sendB");
	assert.equal(JSON.parse(second.v).value.error_type, "busy");
	assert.equal(clickCount, 1, "only the first send clicked");
	page.runTimers(8000);
	await settle();
});

test("page_info reports whether a completion watch is active", async () => {
	const page = createPage({ composer: true, onSend: ({ users, notify }) => {
		users.push({ innerText: "make a file", textContent: "make a file" });
		notify();
	} });
	await sendOnMockPage(page);
await drain(page, sendSettled);
page.window.__LB__.call("page_info", JSON.stringify(null), "info", "test-nonce");
	await settle();
	const info = JSON.parse(page.messages.find((m) => m.t === "rpc_result" && m.id === "info").v).value;
	assert.equal(info.watch.active, true);
	page.window.__LB__.call("cancel_response", JSON.stringify(null), "cancel", "test-nonce");
	await settle();
	page.window.__LB__.call("page_info", JSON.stringify(null), "info2", "test-nonce");
	await settle();
	const info2 = JSON.parse(page.messages.find((m) => m.t === "rpc_result" && m.id === "info2").v).value;
	assert.equal(info2.watch.active, false, "watch is torn down");
});

test("a generation that ends without a new reply reports a provider error, not a timeout", async () => {
	const page = createPage({ composer: true, onSend: ({ users, notify, setStop }) => {
		users.push({ innerText: "make a file", textContent: "make a file" });
		setStop(true); // provider starts generating...
		notify();
	} });
	await sendOnMockPage(page);
	// The send chain resolves across async stages, so the click (and the stop
	// control it reveals) happens INSIDE drain, not during the first setImmediate.
	// Wait for the submission to settle before ending the turn, otherwise the
	// "stop disappears" state lands before the watch even starts generating.
	await drain(page, sendSettled);
	page.setStop(false); // ...then stops without adding an assistant turn
	page.notify();
	await drain(page, providerError);
	const errors = page.messages.filter((m) => m.t === "response_error");
	assert.equal(errors.length, 1, "one error report");
	assert.equal(errors[0].code, "provider_error");
	assert.match(errors[0].message, /stopped generating without adding/i);
	assert.equal(page.messages.filter((m) => m.t === "assistant_message").length, 0, "no fabricated reply");
});

test("a still-generating turn with no reply yet is not treated as an error", async () => {
	const page = createPage({ composer: true, onSend: ({ users, notify, setStop }) => {
		users.push({ innerText: "make a file", textContent: "make a file" });
		setStop(true);
		notify();
	} });
	await sendOnMockPage(page);
	page.runTimers(4000);
	await settle();
	assert.equal(page.messages.filter((m) => m.t === "response_error").length, 0, "a visible stop control means still generating");
	assert.equal(page.messages.filter((m) => m.t === "assistant_message").length, 0);
});

test("an unconfirmed click is accepted (not a hard failure) and is never retried", async () => {
	  let clickCount = 0;
	  const page = createPage({ composer: true, onSend: ({ input }) => { clickCount += 1; input.value = ""; } });
	  await sendOnMockPage(page, "draft a reply");
	  await drain(page, sendSettled);
	  const reply = sendReply(page);
	  assert.equal(reply.error_type, "send_unconfirmed");
	  assert.equal(reply.sent, true);
	  assert.equal(reply.submission_confirmed, false);
	  assert.equal(clickCount, 1, "exactly one click; unconfirmed submission is never retried");
	  assert.match(reply.warning, /awaiting a response without resending/i);
	});

	test("the adapter does not falsely report provider success when submission is unconfirmed", async () => {
	  const page = createPage({ composer: true, onSend: ({ input }) => { input.value = ""; } });
	  await sendOnMockPage(page, "do something");
	  await drain(page, sendSettled);
	  const reply = sendReply(page);
	  assert.notEqual(reply.submission_confirmed, true, "unconfirmed must not be reported as confirmed");
	  assert.notEqual(page.messages.some((m) => m.t === "assistant_message"), true, "no assistant message was pushed; the adapter does not fabricate success");
	});
