# Browser extension integration status

## Current status

The source in [`browser-extension/`](../browser-extension/) came from the supplied `Neelima-Browser-Extension-v0.1.0.zip`. It is a plain JavaScript Manifest V3 extension with ChatGPT, Claude, Gemini, generic HTTPS, popup, options, and manual relay UI. The extension has no build/transpile step. The archive's own README and build status state that the Native Messaging host and Neelima backend integration are absent. This repository change does not claim browser-originated file operations work.

## Extension package and install

Run `./scripts/package-browser-extension.ps1` on Windows PowerShell to create `dist/Neelima-Browser-Extension.zip` and its SHA-256 file. Extract the ZIP and load the extracted directory containing `manifest.json` using `chrome://extensions` or `edge://extensions` with Developer mode enabled.

The extension calls Native Messaging host `com.neelima.browser_bridge`. No host executable, host manifest generator, registry registration/removal scripts, production extension ID, or Neelima-side Native Messaging transport is included yet. The popup should therefore report a connection failure. Do not treat the extension's permission-mode preference as a backend setting.

## Sites and generic protocol

The bundled adapters recognize explicit `neelima-tool` fenced JSON or `<neelima-tool-call>` content and show a user-activated **Review in Neelima** button. Provider selectors are best-effort and may break when sites change. Generic integration requires the user to authorize one HTTPS hostname in Options and enable it on the active tab. Manual relay is available where DOM detection does not work.

Requests use protocol version 1 and these tool names: `list_dir`, `read_file`, `grep`, `glob`, `write_file`, `edit_file`, `move_file`, and `delete_file`. Request/task IDs must be UUIDs. Example:

```json
{"version":1,"request_id":"0f8fad5b-d9cb-469f-a165-70867728950e","operation":"tool.propose","task_id":"7c9e6679-7425-40de-944b-e07fc1f90ae7","tool":"read_file","args":{"path":"README.md"}}
```

The extension adds site and origin metadata after explicit activation. Page content and the extension are untrusted; the future backend must independently validate schema, integration, workspace, path, permission, approval, request idempotency, and result bounds. `docs/BROWSER-THREAT-MODEL.md` records the boundary requirements. `browser-extension/docs/NATIVE-HOST-PROTOCOL.md` is a proposed contract, not evidence of implementation.

## Existing Neelima facilities and missing integration

Neelima already stores selected workspace folders, confines tools through `workspace.rs`, applies permission modes and approvals in `agent.rs`, and records history/checkpoints. Browser requests are not currently routed through those facilities. Completion requires an authenticated local transport, strict host framing and IPC, backend-owned pending approvals/task lifecycle, exact approval binding, host registration for Chrome and Edge, and Windows end-to-end tests. Until then, use Neelima's existing desktop workflow.

## Build and verification

Run `node --test browser-extension/tests/*.test.js` for extension boundary validation tests. Check JavaScript syntax with `node --check` on extension `.js` files. Run Rust checks from the repository root with `cargo test --workspace`. These checks do not establish native host interoperability or Windows browser operation. See [`docs/BROWSER-TESTING.md`](BROWSER-TESTING.md) for what was and was not exercised.
