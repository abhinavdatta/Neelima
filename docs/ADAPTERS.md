# Provider adapters

Adapters are plain JSON files in the app config dir (`Settings → Plugin
Marketplace → Open adapters folder`; `%APPDATA%\com.neelima.app\adapters` on
Windows). They are **hot-reloaded on save** — no rebuild, no restart.

```jsonc
{
  "id": "my-provider",
  "name": "My Provider",
  "url": "https://chat.example.com/",       // the page Neelima opens
  "selectors": {
    "input": "textarea",                     // the prompt box
    "send_button": "button[type=submit]",    // the send control
    "stop_button": null,                     // optional: visible while generating
    "messages": "main",                      // assistant reply nodes (may go stale)
    "new_chat": null,                        // optional: start a fresh chat
    "logged_in": null,                       // optional: ACCOUNT marker (never the composer)
    "logged_out": null,                      // optional: sign-in marker
    "user_message": null                     // optional: the user's own turn (confirmation identity)
  },
  "input": { "kind": "textarea", "max_chars": 8000 },
  "quiet_ms": 2000,                          // one quiet window (completion needs two when no stop control)
  "response_timeout_ms": 300000,
  "built_in": false
}
```

- `input.kind`: `textarea` (native value setter + `input` event — works with
  React-style controlled inputs) or `contenteditable` (select-all +
  `insertText` via `execCommand` — fires the real InputEvents that
  ProseMirror/Slate editors listen to).
- Prompts longer than `max_chars` are inserted in chunks (single send).
- A click is never treated as submission success. Confirmation requires a new
  matching user turn (exact or head+tail match), or an emptied composer plus a
  visible stop control / new assistant turn. An unconfirmed send is reported
  as `send_unconfirmed`, is never retried automatically, and waits a bounded
  window while the reply watch stays armed.
- Completion detection is **event-driven**: a `MutationObserver` on
  `document.body` (SPAs may replace the conversation container) compares reply
  content against a pre-send baseline. The configured `stop_button` is
  authoritative while visible; without one, two independent quiet windows with
  identical content are required, so a stream pause is not reported as a
  finished answer. An SPA that replaces `main` mid-stream cannot deafen it.
- If `messages` selectors go stale, the reply is found as the sibling following
  the last confirmed user turn. If the stop control was seen and then vanished
  without a new assistant turn, the page reports `response_error` and the wait
  fails immediately instead of running to the deadline.
- Streaming previews are display-only, throttled accumulated tails; the agent
  only ever consumes the single completed message.
- Cancellation (Rust cancel/timeout or a superseding send) tears down the page
  watch and disconnects its observer, so a late reply cannot land in the next
  request.

## Response contract and live verification

One request ID is generated per send and echoed on every push; Rust rejects a
push with a missing ID, a mismatched ID, a stale page runtime, or a
non-increasing sequence, and emits `assistant-push-rejected` with the reason.
Lifecycle metadata (`provider-request-state`, no prompt/reply text) is emitted
as `created → submitting → submitted | submission_unconfirmed → streaming →
completed | failed | timed_out | cancelled`. Exactly one terminal state is
reported per request.

The provider sign-in pane's **Send READY check** button (and
`ui_provider_probe`) sends the harmless prompt
`For this connectivity check, reply with exactly READY. Do not use tools.`
through the real send/watch pipeline and displays the captured reply, elapsed
time and request ID. Use it per provider to verify the live path; a reply that
is not exactly `READY` is shown as captured-but-not-READY rather than passed
off as success.

## The Adapter Inspector

DOM selectors break constantly, so users record their own:
**Marketplace → Create with the Adapter Inspector** → enter name + chat URL →
the page opens in the provider webview → log in yourself → click *Capture
input box / send button / last assistant message* and click the matching
element on the page → **Save adapter**. The resulting JSON lands in the
adapters folder and hot-reloads.

## Manual relay (first-class fallback)

If no adapter is configured, or the adapter fails (element not found, login
required), Neelima switches the running task to **manual relay**: the outbound
prompt appears as a copyable card, you paste it into any chat, then paste the
reply back. Parsing, execution, approvals, diffs and checkpoints are identical
— the transport is just you.

## Fair-use notes

Adapters pace actions like a human-operated UI: one message at a time, waits
for real completion, no multi-account rotation, no rate-limit evasion, no
CAPTCHA solving. Automating a site's UI may violate that provider's terms of
service — using an adapter is your responsibility and your account.
