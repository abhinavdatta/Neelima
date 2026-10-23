# Neelima source snapshot — 2026-10-20

This archive contains the tracked source at commit `90cf749e4dcea71a9f99bf34edf5ddd1b8e26359` (`Redesign settings and finalize current Neelima updates`). It is a source package, not a compiled installer or production release.

## Included work
- Reorganized Settings into Appearance, Providers, Local models, Safety, and About sections, with keyboard-accessible category navigation, a dedicated scroll area, responsive narrow-window layout, and a fixed save bar.
- Includes the current Neelima UI, Rust backend, themes, skills work, browser extension source, packaging scripts, and related documentation present in the commit.
- Includes task lifecycle and provider-adapter changes from the same commit. Live provider behavior is not claimed as verified.

## Archive contents
Created directly from committed `HEAD` with `git archive`. It excludes `.git`, build outputs, dependency directories, temporary files, local credentials, backup files, and nested ZIP archives. The separately maintained work log is not included.

## Verification
- `npm run build` in `ui` — passed. Vite reported the existing warning that `ui/src/store.ts` is dynamically and statically imported.
- `npm run build` in `dashboard` — passed.
- `cargo fmt --check --manifest-path src-tauri/Cargo.toml` — passed.
- `cargo test --workspace --locked --manifest-path src-tauri/Cargo.toml` — 94 passed, 0 failed.
- Isolated-target `cargo build --workspace --locked --manifest-path src-tauri/Cargo.toml` — passed using `.tmp/cargo-build-regression`. The default-target build could not replace `target/debug/neelima.exe` because it was in use.
- `node --test src-tauri/tests/adapter-runtime.test.js` — 2 passed.
- `node --test browser-extension/tests/protocol.test.js` — 6 passed.

The desktop app was not launched for visual inspection; no authenticated live provider test was performed. The browser extension’s native host and full extension-to-Rust execution path are not verified as working end to end.

## GitHub
Commit author and committer: `Abhinav Datta <abhi07janamaddi@gmail.com>`. Branches `main`, `feat/browser-to-pc-agent`, and `fix/vite-security` all point to this commit. The push succeeded without rewriting history or adding co-authors.
