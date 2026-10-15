# Phase-0 report — feasibility spike

**Status: 11/11 self-tests PASS on Windows** (`docs/spike-report-windows.md`, `-run2.md` — run 2 proves restart persistence). The spike lives in `spike/` and runs automatically on all three OSes via the `phase0-spike` CI job (`.github/workflows/release.yml`).

Run it yourself:

```bash
cd spike/src-tauri && cargo run -- --selftest --run 1 --report ../../docs/r1.md   # seeds profile storage
cd spike/src-tauri && cargo run -- --selftest --run 2 --report ../../docs/r2.md   # verifies restart persistence
```

## Requirement 1 — multiwebview in one window: ✅ PROVEN

`tauri::window::WindowBuilder` creates a bare window; `window.add_child(WebviewBuilder, position, size)` attaches child webviews. This requires **`tauri = { version = "2", features = ["unstable"] }`** (verified against tauri 2.12.4 source: `#[cfg(any(test, all(desktop, feature = "unstable")))]` on `Window::add_child`).

Self-test evidence (Windows 11, WebView2):

| test | result |
|---|---|
| one window hosts `ui` + `provider` webviews | PASS — `window.webviews().len() == 2` |
| show / hide / `set_size` / `set_position` then eval | PASS — round-trip after lifecycle ops |
| destroy (`close()`) + remount with the same profile | PASS |

Per-OS notes (from the wry/tauri source, not folklore):

- **Windows**: WebView2 supports multiple webviews per window; wry creates one environment per distinct `data_directory`. The known resize-bounds quirk (wry#583) is why Neelima positions the provider webview explicitly from the UI's `ResizeObserver` instead of `auto_resize()`.
- **Linux**: WebKitGTK supports multiple `WebKitWebView`s per window natively. `data_directory` maps to the WebKitGTK data storage path. CI job runs the spike headless under `xvfb`.
- **macOS**: WKWebView historically shares cookies across instances; tauri 2.12 provides `WebviewBuilder::data_store_identifier([u8; 16])` — "Can be used as a replacement for data_directory not being available in WKWebView" — available on **macOS ≥ 14 / iOS ≥ 17**, unsupported on Windows/Linux. Neelima derives a stable 16-byte store id per profile (FnV-style hash) and uses it on macOS.

## Requirement 2 — per-profile isolated persistent data directories: ✅ PROVEN

`WebviewBuilder::data_directory(PathBuf)` (Windows/Linux) / `data_store_identifier` (macOS ≥ 14). Self-test: a storage marker written in the provider webview **survives destroy + remount within a session** and — across two full app runs — **survives an app restart**:

```
T6 … | PASS | marker after remount: "lb-spike-run2"; from previous app run: "lb-spike-run1"
```

Real logins persist the same way: auth cookies live in the profile's WebView2 user-data folder; Neelima never touches them.

## Requirement 3 — injected script + eval round-trip WITHOUT exposing the Tauri API: ✅ PROVEN (with a finding)

Mechanism chosen: **capability-scoped single command**. The app declares an *app ACL manifest* (`src-tauri/permissions/app.toml` → `allow-app-commands`, `allow-lb-bridge`); with the manifest present, tauri 2.12 ACL-checks **every** invocation — local and remote (verified in `tauri-2.12.4/src/webview/mod.rs::on_message`). The `ui` capability grants the app commands to webview `ui`; the `provider` capability grants **only** `allow-lb-bridge` to webview `provider`. Page→Rust messages are small typed JSON (`lb_bridge`, 512 KB cap, serde-validated); Rust→page is `eval`.

**Finding (real, caught by the self-test):** the first capability draft set `windows: ["main"]` on both capabilities. Tauri's runtime authority matches with an **OR** —

```rust
cmd.webviews.iter().any(|w| w.matches(webview)) || cmd.windows.iter().any(|w| w.matches(window))
```

— so `windows: ["main"]` leaked the UI capability (all app commands) to the provider webview. Test T4a caught it (`LEAK-spike-action-reached-rust`); removing `windows` (webview labels only) fixed it, and T4a now returns the precise ACL denial:

```
blocked-as-expected: spike_action not allowed on window "main", webview "provider", URL: local
allowed on: [webviews: "ui", URL: local]
referenced by: capability: spike-ui, permission: allow-app-commands
```

Positive control T4b confirms the `ui` webview is still allowed. Defense in depth: every `ui_*` command in the main app also label-checks its caller.

**Remote pages**: T8 loads `https://example.com/` in a third webview — initialization script runs, the capability-gated IPC works (`pong:example.com`), eval round-trips. Threat model for the one-command surface: [`THREAT-MODEL.md`](THREAT-MODEL.md).

## Requirement 4 — setting text + triggering send from the injected script: ✅ PROVEN

Against a simulated provider page that **deliberately rejects naive automation** (React-style controlled textarea whose state only updates from real `input` events read through the native getter; contenteditable whose state mirrors only real InputEvents; stop-button + delayed streaming; copy-button and citation-token noise inside messages):

- `T5a` textarea strategy: native value setter + `input` event → click send → `MutationObserver` quiet-period completion (stop-button check with bounded rechecks, no `setInterval`) → extraction containing the sent text, the tool block, **and** the `Copy` noise → PASS (1.6 s).
- `T5b` contenteditable strategy: select-all + `execCommand("insertText")` → same pipeline → PASS (1.6 s).

These are exactly the strategies Neelima's production adapter runtime uses (`src-tauri/src/adapter_runtime.js`).

## What did NOT work / caveats

- `opt-level="s"` vs `3`: both compile; see README Performance for the size numbers (3 chosen).
- Local (non-https) remote-capability URL patterns with ports (`http://localhost:*/*`) are not supported by the capability URL matcher — irrelevant in practice because local pages are covered by `local: true`.
- The spike harness stores its marker through a JSON-encoded RPC arg; the first version double-encoded it (harness bug, fixed) — the underlying persistence was never in question.
- macOS/iOS execution of the spike is CI-only from this project (no Apple hardware at authoring time); the `data_store_identifier` path is written per the tauri 2.12.4 API docs and needs a macOS ≥ 14 runner to verify (the CI matrix covers it).
