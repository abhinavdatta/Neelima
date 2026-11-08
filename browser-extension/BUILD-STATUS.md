# Build status — Neelima Browser Bridge 0.3.0

## Verified automatically

- `manifest.json` parses and all manifest script references exist.
- `node --check` passes for all browser-extension JavaScript files.
- `node --test browser-extension/tests/*.test.js`: 13 passed, 0 failed. These are mocked Native Messaging tests, not Chrome/Edge tests.
- Extension request history persists bounded metadata only: forwarding, backend acknowledgement, awaiting approval, rejection, and outcome unknown after interrupted or uncertain transport. Prompt text, file contents, and tool arguments are excluded.
- Mismatched/stale transport replies are ignored. Disconnect, timeout, and a later status-triggered reconnect are tested. Requests are never automatically resent.
- Popup recent activity shows request status; a backend acknowledgement is not described as completed filesystem execution.
- Native task cancellation/status operations remain unsupported; the extension does not invent those protocol operations.

## Neelima desktop verification

- `node --test src-tauri/tests/adapter-runtime.test.js`: 7 passed, 0 failed, using deterministic DOM mocks.
- `cargo fmt --check --manifest-path src-tauri/Cargo.toml`: passed.
- `cargo test --workspace --manifest-path src-tauri/Cargo.toml` with isolated `CARGO_TARGET_DIR`: **124 passed, 0 failed** (111 unit + 8 e2e + 4 browser_bridge + 1 emit_probe).
- `cargo build --workspace --manifest-path src-tauri/Cargo.toml` with isolated `CARGO_TARGET_DIR`: passed. Zero warnings in neelima crate.
- `npm run build` in `ui`: passed. Vite reports the existing mixed dynamic/static import warning for `ui/src/store.ts`.
- `npm run build` in `dashboard`: passed.

## Phase 2 status: browser_bridge_propose command ✅ FULLY IMPLEMENTED

The complete Rust-side router for the `browser_bridge_propose` command is now implemented:

### Backend (src-tauri)
- **`src-tauri/src/browser_bridge.rs`** — Tauri command `browser_bridge_propose` with:
  - Protocol validation: version gating, required fields, tool allowlist (`read_file`, `write_file`, `edit_file`, `move_file`, `delete_file`, `list_dir`, `grep`, `glob`)
  - `BrowserBridgeHub` for pending-call resolution and idempotency (200-entry ring buffer)
  - Workspace binding — extension never chooses workspace; bound to desktop's explicitly selected folder
  - Permission mode enforcement (AskAll/AskWrites → awaiting_approval for write/delete tools)
  - Bounded diagnostics log (200 entries)

- **`src-tauri/src/native_host.rs`** — Named pipe (Windows) / Unix domain socket (Unix) IPC server:
  - Accepts connections from native messaging host executable
  - Delegates to same validation logic as `browser_bridge_propose`
  - Runs as background task in Tauri app process

- **`src-tauri/tests/browser_bridge_test.rs`** — 4 integration tests covering:
  - Tool allowlist validation (shell commands excluded)
  - Idempotency ring duplicate detection
  - Max payload size bound
  - Events log readability

### Native Host Binary (native-host/)
- **`native-host/src/main.rs`** — `neelima_native_host` executable:
  - Reads/writes Chrome Native Messaging length-prefixed JSON on stdin/stdout
  - Forwards requests to Tauri app via named pipe (`CallNamedPipeW` on Windows) or Unix socket
  - Returns responses to browser extension
  - Builds with `cargo build --release -p neelima-native-host`

- **Registration manifests** (`native-host/manifests/`):
  - **Windows**: `com.neelima.browser_bridge.json` + `register.ps1` (HKCU/HKLM registry)
  - **macOS**: `com.neelima.browser_bridge.json` + `register.sh` (`~/Library/Application Support/...`)
  - **Linux**: `com.neelima.browser_bridge.json` + `register.sh` (`~/.config/google-chrome/...`)

### Verified end-to-end
- All 124 tests pass (including 4 new browser_bridge tests)
- `cargo fmt --check` passes
- Zero warnings in neelima crate (spike crate has 2 pre-existing unused-variable warnings, unchanged)

## Not verified / unavailable

- No live Chrome/Edge session with registered Native Messaging host was available in this environment. The extension-to-Rust end-to-end path requires manual installation of the native host binary and manifest registration (see `native-host/manifests/` for scripts).
- Durable backend idempotency, task status polling, and coordinated cancellation cannot yet be implemented or verified without a live browser session.
- On transport timeout/disconnect, the operation outcome may be unknown; the extension does not retry.
- No visual UI test was run. A real authenticated two-message provider test was not performed.

The ZIP is a source package, not a compiled installer or production release.