# Browser extension tests and verification

## Extension checks

Run from the repository root:

```powershell
node --test browser-extension/tests/*.test.js
Get-ChildItem browser-extension -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
./scripts/package-browser-extension.ps1
```

These cover the isolated request validator and syntax/package generation. They do not test a real browser, Native Messaging host, host registration, desktop IPC, workspace access, approval flow, or checkpoint recovery.

## Manual extension smoke check

1. Load `browser-extension/` unpacked in Chrome and Edge.
2. Inspect popup/options rendering and built-in site toggles.
3. Verify an unauthorized generic hostname cannot be enabled; grant one HTTPS hostname explicitly and inject only on that active tab.
4. On a supported AI page, verify only a detected candidate displays a **Review in Neelima** control and a user click is needed to forward it.
5. With no host installed, verify the extension reports a connection error and does not claim any file operation completed.
6. Verify malformed requests and unapproved sites are rejected.

## Desktop baseline

Run `cargo test --workspace --locked` from the repository root. An initial invocation waited for a Cargo build-directory lock; a later invocation completed successfully with 65 Neelima unit tests passing, 0 failed, plus the spike and binary targets (0 tests each). The suite was run after the extension changes; no Rust source was changed in this integration.

## Required before end-to-end acceptance

Add tests for Native Messaging framing and bounds, exact extension-origin authorization, IPC client ACL/authentication, app-not-running and reconnect behavior, request idempotency, workspace revocation, traversal and link escapes, both permission modes, approval binding/change invalidation, denied side effects, bounded result delivery, service-worker restart/status recovery, Chrome and Edge registration/removal, and checkpoint restore. Run the browser/installer cases on Windows 11. No such end-to-end test is claimed by this change.
