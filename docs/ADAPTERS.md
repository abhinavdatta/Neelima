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
    "messages": "main",                      // container that mutates during streaming
    "new_chat": null,                        // optional: start a fresh chat
    "logged_in": null                        // optional: selector that exists only when logged in
  },
  "input": { "kind": "textarea", "max_chars": 8000 },
  "quiet_ms": 2000,                          // completion = this much mutation-silence
  "response_timeout_ms": 300000,
  "built_in": false
}
```

- `input.kind`: `textarea` (native value setter + `input` event — works with
  React-style controlled inputs) or `contenteditable` (select-all +
  `insertText` via `execCommand` — fires the real InputEvents that
  ProseMirror/Slate editors listen to).
- Prompts longer than `max_chars` are inserted in chunks (single send).
- Completion detection is **event-driven**: a `MutationObserver` on the
  messages container re-arms a quiet-period timer; the stop-button state is
  checked with bounded rechecks. No `setInterval` polling anywhere.

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
