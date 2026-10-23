# Neelima Phase 2 source update — 2026-10-20

This ZIP updates the uploaded Neelima source snapshot with writable historical conversations, provider-response lifecycle fixes, and the Browser Bridge 0.3.0 reliability work. It is source code, not an installer or production release.

## Implemented

- Historical chats open in Neelima's normal composer. Sending from one starts a new continuation task, preserves the archived transcript, checks the selected workspace, and provides bounded earlier transcript context to the model. Subsequent prompts in the current chat continue the same stable conversation ID. The provider page is reused for a matching Neelima conversation; a different conversation starts a new provider chat.
- Provider send acknowledgement requires a matching newly inserted user message. An emptied composer alone is not success; no uncertain prompt is resent.
- Provider response pushes carry a runtime session ID and monotonically increasing sequence. Rust accepts only new responses from the current runtime and keeps origin/nonce protections. A response is accepted only when a new assistant message is nonempty, stable, and no longer streaming.
- Extension 0.3.0 records bounded request lifecycle metadata without prompts, file contents, or tool arguments; ignores mismatched responses; marks interrupted/uncertain requests outcome-unknown; and never automatically replays side-effecting proposals. The popup displays backend acknowledgement separately from operation completion.
- The extension's normal conversation remains Neelima. Manual relay is no longer selected by default when no provider is configured.

## Verification

- `cargo fmt --check --manifest-path src-tauri/Cargo.toml` — passed.
- `cargo test --workspace --locked --manifest-path src-tauri/Cargo.toml` with `CARGO_TARGET_DIR=.tmp/cargo-phase2-build` — 98 passed, 0 failed.
- `cargo build --workspace --locked --manifest-path src-tauri/Cargo.toml` with isolated target — passed; existing unused-variable warnings in the spike crate remain.
- `node --test src-tauri/tests/adapter-runtime.test.js` — 7 passed using deterministic DOM mocks.
- `node --test browser-extension/tests/*.test.js` — 13 passed using mocked Native Messaging.
- Extension JavaScript syntax and manifest-reference checks — passed.
- `npm run build` in `ui` and `dashboard` — passed. The UI build retains its existing Vite mixed dynamic/static import warning.
- ZIP integrity check — run after packaging.

## Limitations

No authenticated live provider, Chrome/Edge session, or Native Messaging host was available. This repository still has no native host or Rust browser-proposal router, so durable backend idempotency, remote task status, and coordinated cancellation remain unavailable. On disconnect or timeout the true operation outcome may be unknown. Resuming an older Neelima chat whose provider page has since moved to another conversation starts a new provider chat seeded with prior transcript context; this is a continuation branch, not reopening the provider's remote chat. No live two-message test or visual desktop test was performed.

The archive is built from committed `HEAD` plus the current in-scope source edits. `.git`, build outputs, caches, local artifacts, and the separate work log are excluded. No commit or push was made for this update.
