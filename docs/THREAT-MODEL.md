# Threat model

## Assets and adversaries

| Asset | Adversary | Mitigation |
|---|---|---|
| Workspace files | The AI (hallucination, jailbreak), prompt injection smuggled in via files/command output/web pages | Workspace confinement on every path; permission modes; approval queue with diffs; git checkpoints before every write batch; emergency stop |
| Provider account credentials | Anything outside the provider webview | Credentials never leave the webview's per-profile data directory; Neelima's code never reads cookies/storage/tokens; injection scripts only touch the input element and the last assistant message |
| The rest of the user's computer | Compromised provider page (site XSS or malicious site) + the app ACL | See capability design below |
| Running commands | The AI, prompt injection | Denylist (non-removable defaults) + optional allowlist, cwd forced into workspace, timeouts, streaming output, kill button, process-tree cleanup |

## The one-command bridge (why this design)

Capabilities in Tauri v2 are **compile-time** artifacts, but adapter domains are **runtime** data (users add providers without rebuilding). The security boundary therefore cannot rely on a URL allowlist in the capability. Instead:

1. `src-tauri/permissions/app.toml` defines the app ACL manifest: `allow-app-commands` (all UI commands) and `allow-lb-bridge` (`lb_bridge` only). With the manifest present, **every** invocation — local or remote — is ACL-checked against the calling (window, webview, origin).
2. Capabilities reference **webview labels only, never `windows`**. Tauri's runtime authority matches with an OR (`webviews.any(...) || windows.any(...)`), so a capability listing `windows: ["main"]` would leak to every webview in that window — this exact privilege-escalation gap was caught by the Phase-0 spike self-test (T4a) and fixed; see `docs/PHASE-0-REPORT.md`.
3. The `provider` webview capability grants **only** `allow-lb-bridge`. A remote wildcard is accepted here deliberately: even a fully compromised provider page can reach exactly one command, which accepts a small, typed, size-capped JSON message (`512 KB max`, serde-validated) and nothing else.
4. Defense in depth: every `ui_*` command label-checks its caller (`webview.label() == "ui"`) — a second, independent wall in case the ACL is ever misconfigured.
5. `lb_bridge` cannot *do* anything destructive by itself: it resolves pending adapter RPCs and feeds the agent loop, where tool calls go through the same approval pipeline as any other AI output. A malicious page can at worst inject fake "assistant" tool calls — which the permission modes and approval UI are designed for.

## Residual risks (documented, accepted for v0.1)

- A compromised provider page could spam bridge messages (noise) or fake tool calls (gated by approvals). It cannot read the filesystem, run commands, or reach UI commands.
- TOCTOU on path confinement: paths are canonicalized at call time; a racing symlink swap by another process is out of scope.
- The preamble instructs the model to treat tool results as data. Deterministic injection-proofing does not exist; the warning-badge heuristic is coarse (high recall, low precision) and approvals remain the hard gate.
- The user's own shell environment is inherited by `run_command` (needed for PATH). The denylist blocks known dangerous patterns but cannot enumerate all harm. Built-in approval patterns are non-removable even in *Full access* mode; those commands require approval before the separate command deny check. The default permission mode is *Ask every time* (`ask_all`): reads, writes and commands require approval according to the tool-risk policy. Full access is an explicit user-selected mode, not the default.
- When a task uses an embedded cloud AI website, Neelima sends prompts and tool results—including local file contents returned by read tools—through that provider's web UI. The provider's own retention and training policies apply. The current app has no per-provider/session consent gate or automatic sensitive-file exclusion for this data flow. Do not send sensitive content to a cloud provider; use a local model or manual relay where appropriate. A local Neelima process does not make cloud-provider processing local.

## Network policy

The Rust binary only ever contacts: `http://127.0.0.1:*` (Ollama/LM Studio, user-configured) and URLs the user configures for the provider webview (loaded inside that webview, not fetched by Neelima). No telemetry, no update pings, no analytics — there is no code path that could send anything anywhere else.
