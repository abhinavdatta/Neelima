# Neelima Phase 3 — Live Provider Bridge Work Log

## Status

Phase 3B (isolate the RPC timeout) is complete and verified. The r8 timeout root cause was identified and fixed; regression tests were added at both the Rust and Node levels. Live end-to-end verification against an authenticated provider profile was NOT performed — the user did not run the app through a live sign-in, and security constraints forbid accessing cookies/tokens/profile databases to verify auth state. The provider login diagnostic remains `unknown` from safe diagnostics only.

No commit or push was made for Phase 3B work.

## Phase 3B — r8 RPC timeout (complete, verified)

**Root cause:** The original RPC budget for `send_message` used `CALL_TIMEOUT_MS = 10_000`, which was shorter than the page-side send path (`waitForSendButton(3000)` + `waitSubmission(8000)` ≈ 11s worst case). Rust cancelled `r8` before the adapter's submission acknowledgement could arrive, so a legitimate submission looked like a timeout.

**Confirmed fix (defect only, no speculative changes):**
- `src-tauri/src/webprov.rs`: `WebProvider::send()` now uses `call_with_timeout("send_message", ..., SEND_CALL_TIMEOUT_MS = 25_000)` instead of the 10s `CALL_TIMEOUT_MS` budget.
- `classify_send_result()` accepts `send_unconfirmed` as a non-fatal acknowledgement (records `submission_unconfirmed`, returns `Ok`) instead of `SendFailed`.
- `wait_reply()` uses `UNCONFIRMED_REPLY_WAIT_MS` bounded wait.

**Regression tests added:**
- `src-tauri/tests/bridge.rs` — `r8_send_lifecycle_cancel_then_late_result`: verifies a cancelled RPC's late result is diagnosed as stale/cancelled and does not resolve the pending rx, while a concurrent live call (`r9`) with the correct nonce still resolves normally (no cross-talk).
- `src-tauri/tests/adapter-runtime.test.js` — two added tests: unconfirmed click is accepted and never retried; adapter does not falsely report success.

**Verification run:** `cargo fmt --check`, `cargo test --workspace --locked`, `npm --prefix ui run build`, `node --test src-tauri/tests/adapter-runtime.test.js`, `node --test browser-extension/tests/*.test.js`, and `git diff --check` all passed.

## Live request evidence (r8, pre-fix observation)

The harmless request asked the provider to respond with `READY`.

Sanitized bridge diagnostics showed:

1. Provider page readiness and login-state reporting occurred.
2. Diagnostic/page-info RPCs completed, and the task's earlier RPC (`r7`) resolved.
3. The next RPC (`r8`) remained pending until Rust's bridge timeout cancelled it.
4. A late result for `r8` was rejected as stale.
5. No assistant-response event reached Rust, no tool calls ran, and no file was created.

The last confirmed request-path success is the earlier RPC resolution (`r7`); the `r8` submission/result and provider-response stages were not confirmed. The timeout leaves the submission outcome unknown, so the task must not be blindly resent.

## Changes (Phase 3B)

- `src-tauri/src/webprov.rs` — `send_message` uses `call_with_timeout` with `SEND_CALL_TIMEOUT_MS = 25_000`; `classify_send_result` accepts `send_unconfirmed`.
- `src-tauri/tests/bridge.rs` — added `r8_send_lifecycle_cancel_then_late_result` regression test.
- `src-tauri/tests/adapter-runtime.test.js` — added 2 tests (unconfirmed click accepted+never retried; adapter does not falsely report success).
- `src-tauri/assets/adapter-demo.json` — added `"user_message": ".msg.user"`.
- `src-tauri/assets/adapter-chatgpt.json` — added `"user_message": "[data-message-author-role=\"user\"]"`.
- `src-tauri/src/adapters.rs` — `Selectors` gained `user_message: Option<String>` field.
- `src-tauri/src/ui.rs` — added `user_message: None` to Selectors initializer.
- `ui/src/App.tsx` — replaced dynamic `import("./store").then((m) => m.resetTask())` with direct `resetTask()` call (store is already statically imported); removed the duplicate import.

## Remaining work — in priority order

1. **Live E2E against authenticated provider profile** (requires the user to run the app, complete sign-in, observe `provider-login-state → logged_in`, then send one harmless prompt and confirm its response reaches Rust). Authentication state cannot be verified by the assistant — security constraints forbid cookie/token/profile access.
2. Once live provider response is confirmed, run a small file-operation task in a fresh temporary workspace: verify create/read/edit, approved command output, sequential tool calls, recoverable failure, cancellation, permissions, and UI progress.
3. Reviewer P0/P1 findings (browser extension native host, content-script MutationObserver, destructive-command tests) are out of scope — tracked as backlog.

## Outcome classification

- **Implemented:** r8 timeout root-cause fix, regression tests, P2 duplicate-import fix.
- **Unit/integration-tested:** bridge lifecycle test, adapter-runtime tests (11 passed), agent-loop e2e tests (8 passed).
- **Build-tested:** UI build clean (no duplicate-import warning), `cargo test --workspace --locked` passed, `cargo fmt --check` passed.
- **Live end-to-end verified:** **No.** No real provider response reached Rust, and no live coding task completed. Authentication state remains `unknown` from safe diagnostics only.
