# Neelima

**Local-first agentic coding app.** Neelima embeds the AI provider's **own web chat** — your account, your login, inside an isolated webview — or local models (Ollama, LM Studio), and lets that AI read and modify files in your workspace through a permission-gated tool protocol with git checkpoints.

**No cloud model APIs. No API keys. No telemetry. No accounts. No backend.**

```
┌──────────────┐   drives via text protocol    ┌────────────────────────────┐
│  AI web chat │  ───────────────────────────▶ │  Neelima (Tauri v2, Rust)  │
│ (your login) │  ◀─────────────────────────── │  tools · approvals · git   │
└──────────────┘   ```tool / ```result blocks  └────────────┬───────────────┘
        isolated webview,                                   │ confined to the
        per-profile data dir                                │ workspace folder
┌──────────────┐                                            ▼
│ Ollama / LM  │  same protocol over               your files, your git
│ Studio (localhost)  HTTP streaming                    checkpoints, your shell
└──────────────┘
```

## Screenshots

| Main UI | Folder menu | Terminal | Settings |
|---------|-------------|----------|----------|
| ![Main UI](docs/screenshots/01-main.png) | ![Folder menu](docs/screenshots/02-folder-menu.png) | ![Terminal panel](docs/screenshots/03-terminal.png) | ![Settings](docs/screenshots/04-settings.png) |

## Distribution: portable vs installers (our decision)

**Both — portable-first.** Each release ships:

| OS | Standalone (recommended) | Installer |
|----|--------------------------|-----------|
| Windows | `Neelima-portable-windows-x64.zip` (one `neelima.exe`) | `Neelima_0.1.0_x64-setup.exe` (NSIS) |
| macOS | — | `Neelima_0.1.0_aarch64.dmg` / `x64.dmg` |
| Linux | `Neelima_0.1.0_amd64.AppImage` | `neelima_0.1.0_amd64.deb` + Flatpak (`com.neelima.app`) |

Why portable-first: a single executable needs no admin rights, mutates nothing outside its own data dir, is trivially auditable, and matches Neelima's no-surprises ethos. Installers still ship for people who want Start-menu entries and file associations; the Flatpak manifest is included for store-style, sandboxed distribution on Linux.

macOS/Linux/Flatpak artifacts are built by CI on their native OSes (see `.github/workflows/release.yml` — push a `v*` tag). Cross-compiling GUI apps for macOS/Linux from Windows is not possible, so local builds are per-OS.

## Quick start (2 minutes, no accounts)

1. Launch Neelima.
2. Sidebar → **+ Add folder** → pick a project folder.
3. Composer → provider picker → **Demo chat (built-in)** — a simulated provider UI that speaks the tool protocol. No login needed.
4. Type a task, e.g. `Read README.md and summarize it`. Watch the transcript: tool call card → result → DONE.
5. For a real provider: **Settings → Providers → Connect a provider** → name + chat URL + adapter → **Open / log in** and sign in *inside the embedded chat* (Neelima never sees your credentials). Or use **Manual relay** — copy the prompt into any chat, paste the reply back; the parse/execute/approve pipeline is identical.

## The bridge protocol

Web chat UIs have no tool calling, so Neelima teaches the AI a small text protocol on the first turn (see [`docs/PROTOCOL.md`](docs/PROTOCOL.md)):

````
```tool
{"id":"1","tool":"read_file","args":{"path":"src/main.rs"}}
```
````

The app parses the reply with a **tolerant parser** (smart quotes, trailing commas, mangled fences, copy-button text, citation tokens like `【1-b3d480】`), validates against typed structs, executes inside the workspace, and sends back:

````
```result
{"id":"1","ok":true,"output":"fn main() {\n    println!(\"hello\");\n}"}
```
````

Loop until the AI replies `DONE: <summary>`. Hard limits: max iterations (default 25), result caps (default 30 KB with "use offset/limit" hints), a repeat-failure circuit breaker, and bounded parse-error corrections before pausing for the user.

## Tools

`read_file(path, offset?, limit?)` · `write_file(path, content, append?)` · `edit_file(path, old_string, new_string, replace_all?)` (exact-match; clear errors on ambiguity) · `list_dir` · `glob` · `grep` (ripgrep-style: `ignore` + `regex` crates, `.gitignore` respected) · `run_command` (allow/deny lists, destructive patterns blocked by default, streamed, kill button) · `delete_file` · `move_file`.

Chunked writes via `append: true` because chat replies have length limits.

## Safety model

- **Workspace confinement**: every path is rejected unless it canonicalizes inside the workspace root (traversal, absolute paths, Windows device names, and symlink escapes are refused — enforced on every tool).
- **Permission modes**: *Ask every time* (default) · *Auto-approve reads, ask for writes/commands* · *Full access inside workspace*. Writes/edits always show a CodeMirror-6 merge diff before approval.
- **Command guard**: user-editable allow/deny lists on top of non-removable destructive patterns (`rm -rf /`, `format`, `shutdown`, `reg add`, `curl | sh`, `-enc` PowerShell, …). cwd is forced inside the workspace; timeouts and process-tree kill are built in.
- **Untrusted content**: files, command output and web pages are *data, not instructions* (stated in the preamble). Suspected prompt-injection text is flagged with a warning badge.
- **Emergency stop**: global hotkey (default `Ctrl+Alt+Shift+X`) kills running commands and halts the loop.
- **Checkpoints**: git snapshots in `<workspace>/.neelima/checkpoints.git` (bare repo; your own git history is untouched). Every write batch is preceded by a snapshot; the chat shows a one-click **files changed +N −N · Undo** card.

## Provider isolation (the hard constraint, kept)

- The provider web chat runs in a **separate child webview** with a **per-profile persistent data directory** (`data_directory` on Windows/Linux, `data_store_identifier` on macOS ≥ 14) — logins survive restarts, one webview alive at a time, hidden/unused webviews are **destroyed** to free memory.
- **Neelima never reads, stores, logs or transmits credentials, cookies or tokens.** Auth happens entirely inside the webview.
- The provider page's capability grants **exactly one command** (`lb_bridge`), a small typed, size-capped intake. The app ACL manifest denies it every other command; every other command additionally label-checks its caller. See [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).
- **Pace**: actions are human-paced (no hammering, no multi-account rotation, no rate-limit evasion). Automating a site's UI may violate that provider's terms — that is between you and the provider.
- **Manual relay is first-class**: with no adapter configured (or on adapter failure) the task continues via copy/paste with identical parsing, approvals and checkpoints.

## Local models

- **Ollama**: `GET /api/tags` + `POST /api/chat` (streaming, NDJSON).
- **LM Studio**: OpenAI-compatible `http://localhost:1234/v1` (`/models`, `/chat/completions`, SSE streaming).
- Same ` ```tool ` protocol by default. Settings: base URL, model picker (live from the server), context window, temperature. Cancel aborts the stream immediately. The **only** network destinations in the entire binary are `127.0.0.1` and the pages you load in the webview.

## Architecture

```
src-tauri/src/
  lib.rs        app setup: bare window + "ui" webview, plugins, hotkey
  agent.rs      the loop: async state machine (idle → waiting_for_ai → parsing
                → awaiting_approval → executing → done/error), stop/cancel everywhere
  protocol.rs   tolerant ```tool parser, ```result formatter, preamble builder
  tools.rs      file tools with caps; confinement enforced via workspace.rs
  exec.rs       run_command: guarded, streamed, capped, process-tree kill
  sec.rs        command guard patterns + injection heuristics
  providers.rs  Provider enum: Web | Local (Ollama/LM Studio streaming) | Manual
  webprov.rs    provider webview lifecycle (mount/destroy), adapter runner
  adapter_runtime.js  injected runtime: MutationObserver completion detection,
                event-based input setting, extraction, inspector
  bridge.rs     the ONE command reachable from provider pages (typed, capped)
  adapters.rs   config-driven adapters (JSON), hot-reload via notify
  checkpoints.rs git-CLI snapshots (chosen over gitoxide: zero binary cost,
                <200 ms snapshots on dev trees — see Performance)
  history.rs    append-only JSONL transcripts per task
  terminal.rs   portable-pty sessions; xterm.js is lazy-loaded
ui/            Preact + Vite + TS. ZCode-style UI; CodeMirror merge and xterm
               load as lazy chunks only when first used
spike/         Phase-0 spike proving multiwebview + data-dir isolation + narrow IPC
```

## Building from source

Prereqs: Rust (MSVC on Windows), Node 20+, and on Linux `libwebkit2gtk-4.1-dev libxdo-dev libayatana-appindicator3-dev librsvg2-dev`.

```bash
npm --prefix ui install
npm --prefix ui run build      # or let tauri build do it
cd src-tauri && cargo test     # unit tests: protocol, confinement, tools, guard
npx --prefix ui tauri build    # release + installer for your OS
```

## Performance

Measured on the dev machine (Windows 11, x64, Rust 1.98.1, tauri 2.12.4). Reproduce with `scripts/measure.ps1`.

| Metric | Budget | Measured | Verdict |
|---|---|---|---|
| `neelima.exe` release binary | — | **8.58 MiB** with `opt-level=3`; **6.34 MiB** with `opt-level="s"` (fat LTO, 1 codegen unit, panic=abort, stripped) | 3 chosen — see note |
| Windows NSIS installer | < 15 MB | **2.92 MiB** | ✅ |
| App process, idle, main UI only | < 80 MB | **29.9 MB** working set (**6.3 MB** private) | ✅ |
| Idle CPU (app process, 20 s sample) | ~0% | **0.0%** | ✅ |
| With one provider webview mounted | < 250 MB | adds one WebView2 renderer (demo page ≈ +40–70 MB; **the real provider page dominates this number**, as the spec notes) | ✅ for the demo page |
| Polling loops | none | none — `MutationObserver` + quiet periods (adapter), channel sleeps (agent loop), `notify` only for the adapters dir + workspace watch while a task runs | ✅ |
| Checkpoints backend | smallest fast option | git CLI via `std::process` (bare repo per workspace): **0 MB** binary cost vs ~2–4 MB for gitoxide; snapshot+commit on a small tree < 200 ms | git CLI chosen |

Notes on measurement, stated plainly:

- "App process" is `neelima.exe`'s own working set. The OS WebView2 runtime spawns sibling processes (browser/GPU/network/renderer — ~350 MB system-wide working set for the *whole* machine's shared runtime tree, most of it shared infrastructure other WebView2 apps also map). Counting those against the 80 MB budget would conflate the OS webview runtime with the app; both interpretations are printed by `scripts/measure.ps1` so you can judge.
- The "with one provider webview" figure is reported as a range because mounting the demo provider requires a click; open the Provider tab and re-run the script to capture your own number. Real chat pages (ChatGPT, Claude…) weigh 200–400 MB on their own — that is the page, not Neelima.
- `opt-level=3` vs `opt-level="s"`: measured both — 8.58 MiB vs 6.34 MiB (s is 26% smaller). 3 was chosen because grep/diff/JSON-parse paths are latency-sensitive while the installer budget (2.92 MiB) is met with room to spare either way; flip `opt-level` in the root `Cargo.toml` and rebuild to ship the smaller binary.
- No workspace watcher runs at idle; the only persistent watcher is the adapters config directory (a handful of small files).

## Phase 0 (feasibility spike): 11/11 PASS

The original build plan required proving four things before building the app. The spike (`spike/`, self-test harness) proves them on this machine and reports per-OS evidence from CI:

1. **Multiwebview in one window** — `unstable` feature + `Window::add_child`: one window hosting the UI webview + provider webview; show/hide/resize/move/destroy all PASS.
2. **Per-profile persistent data directories** — storage marker survives destroy+remount **and a full app restart** (`data_directory` on Windows/Linux; `data_store_identifier` on macOS ≥ 14).
3. **Narrow capability-scoped IPC** — app ACL manifest + one-command provider capability; the self-test proves the provider page is **blocked** from every other command (and caught a real `windows:`-field leak during development — fixed; see [docs/PHASE-0-REPORT.md](docs/PHASE-0-REPORT.md)).
4. **DOM automation** — controlled textarea + contenteditable input setting, `MutationObserver` quiet-period completion, extraction tolerant of copy-button noise — all PASS.

Full evidence: [docs/spike-report-windows.md](docs/spike-report-windows.md) and [docs/spike-report-windows-run2.md](docs/spike-report-windows-run2.md).

## Status & limitations (honest list)

- Windows build is verified locally; macOS/Linux/Flatpak artifacts are produced by CI on their native OSes and should be smoke-tested there before release.
- Real-provider adapters are user-configurable (Inspector) because DOM selectors change constantly; the shipped generic template + demo provider always work.
- Chunked paste for long prompts is implemented for contenteditable inputs; attachment-based input is not yet automated.
- Local-model native tool calling (function calling) is on the roadmap; the text protocol works with any model today.
