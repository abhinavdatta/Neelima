# Video-driven UI repair report

## Findings addressed

- **Settings was difficult to discover and could be obscured by the embedded provider window.** Settings is available from the persistent navigation rail and title bar. The modal has a sticky header and footer, responsive layout, visible focus styles, Escape/backdrop/close handling, and a discard confirmation for unsaved drafts. The provider child webview is hidden while Settings is open because a native child webview cannot be layered with HTML `z-index`.
- **Settings changes had unclear save behavior.** Form values are staged as drafts and applied with an explicit Save action. Cancel discards them. Local model URLs can be tested only after they match the saved value; model discovery and connection errors use backend results.
- **Appearance settings were missing.** Added persisted Light, Dark, and System theme choices. Existing settings files without the new field continue to load with the current Dark appearance. System follows the OS color-scheme changes while the app is open.
- **Provider status could imply a working session when state was unknown.** Provider status now distinguishes a ready session, login required, and unknown state. The provider view has a return-to-Neelima action and explains that typing directly into the provider website does not run workspace tools.
- **Successful provider login did not actually trigger the return flow.** The UI had been listening for a `provider-login-complete` event that the Rust backend never emits. It now returns to chat on the backend's real `provider-login-state: logged_in` event, while leaving the isolated provider session mounted and hidden.
- **The recording showed a task ending with “tools are not available” while looking successful.** The backend now treats that response as a task error and gives an actionable message. The protocol instructions tell the model how to call Neelima tools.
- **Several controls and cards implied functionality that was not present.** Home actions and composer suggestions now describe supported work. Search shows real empty/no-match states instead of listing unrelated tasks. Checkpoint creation reports its backend result. The removed mascot and Upgrade CTA no longer appear in the home UI.
- **Provider profile cleanup needed an explicit user action and path checks.** Settings offers a confirmed clear-sign-in-data action. The backend rejects invalid profile IDs and symlink escapes; missing storage is handled safely, including dangling symlink metadata.
- **Skills marketplace had discovery without a safe install/management path.** The current source includes a repository preview/import flow, local installation scopes, provenance and license display, installed skill enable/disable, update comparison, uninstall confirmation, and untrusted-instruction handling with bounded per-task selection. See [SKILLS.md](SKILLS.md) for the supported behavior and limits.

## Remaining work

- The browser extension still has no matching Native Messaging host or Rust/Tauri bridge integration. Its README and status UI state that it cannot access local files yet. Browser-to-PC execution, armed-session UI, and native-host registration/packaging remain incomplete.
- Marketplace uses a user-provided public GitHub repository URL; repository-wide discovery/search is not implemented. Live GitHub API behavior and network failure cases were not tested here.
- The desktop application was not launched for manual visual inspection, so screenshots and live checks at target window sizes are unavailable. Build/test success does not establish that the native child webview behaves correctly on screen.
- UI interaction automation for modal focus trapping, route-by-route Settings access, and Marketplace install/update flows is not configured in this repository and was not run.

## Verification

- `cargo fmt --all -- --check` — passed.
- `cargo test --workspace --locked` — passed, 83 Rust library tests; other workspace targets and doc tests had zero tests.
- `cargo build --workspace --locked` — passed.
- `cargo clippy --workspace --locked --all-targets` — passed with existing warnings in `spike/src-tauri/src/main.rs`, `src-tauri/src/history.rs`, and `src-tauri/src/sec.rs`.
- `npm ci` in `ui` — completed; npm reported 2 advisories (1 moderate, 1 high) and blocked the `esbuild` install script under the configured script policy.
- `npm run build` in `ui` — passed after `npm ci`; Vite reported the existing mixed dynamic/static import warning for `store.ts`.
- `node --test browser-extension/tests/*.test.js` — passed, 6 tests.
- `git diff --check` — passed.

No commit or push was made.
