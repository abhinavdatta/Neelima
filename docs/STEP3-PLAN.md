# Step 3 — Project Context Retrieval

Status: **implemented in source and tested** (2026-10-23). See the
“Implementation record” section at the end for what actually shipped, the exact
test results, and what is still unverified. The plan and invariants below are
kept unchanged from the preparation pass so the constraints remain auditable.

## Why this document exists

Step 2 made every provider share one request lifecycle and one correlation path.
Step 3 adds the other half of an agentic coding loop: deciding *which files* in the
workspace are relevant to a prompt and sending their contents to whichever provider
the user picked. Writing the constraints down first prevents Step 3 from quietly
breaking the guarantees Step 2 established.

## What Step 3 must not break

| Invariant (established in Step 2) | Constraint for Step 3 |
|---|---|
| One provider-independent `RequestRecord` per send, metadata only | Context assembly happens BEFORE `send`; the registry never stores file contents or prompts. Context size may be recorded as a number, never as text. |
| `request_id` correlation across web/local/manual providers | Context is attached to the prompt text handed to the provider; it must not create a second request or bypass the registry. |
| Adapter DOM handling stays inside adapters | Context selection never inspects provider pages. It reads the workspace only. |
| Local runtimes are loopback-only (`ensure_local_endpoint`) | Retrieval must not introduce a hosted embedding API, vector database service, or cloud index. |
| Approvals: no tool executes without the existing permission path | Gathering context is read-only and must not be a silent way to read outside the workspace. |
| Workspace confinement (`Workspace::open`, path checks) | Every path considered by retrieval is resolved through the same confinement code, never a raw `fs::read` on user input. |

## Non-negotiables

- No hosted AI API, no API key, no cloud inference or fallback.
- No embedding service, no network call: retrieval must be local and deterministic.
- Read-only: Step 3 selects and embeds file contents; it does not edit files. Editing
  stays with the tool/approval system from earlier phases.
- DeepSeek/Qwen remain local-runtime models: whatever context is assembled must work
  with a plain text prompt sent to Ollama/LM Studio as well as to a browser chat.

## Proposed design (to be validated in Step 3, not implemented here)

1. **Index** — a bounded, on-demand index of the active workspace: paths, sizes,
   line counts, and a simple tokenized term count (BM25-style scoring). No vectors,
   no persistence beyond the session, no network. Reuses `Workspace` for traversal
   and honours `.gitignore` the way `grep`/`glob` tools already do.
2. **Selection** — score files against the prompt plus recent transcript terms;
   expand to neighbours (imports/`mod` declarations where cheap); cap by a token
   budget derived from the selected provider's practical limit (browser chats and
   local models differ, so the budget is a per-provider setting, not a constant).
3. **Assembly** — emit a clearly delimited context block with file paths and line
   ranges, inserted ahead of the user's instruction. The prompt must state when it
   was truncated so the model does not assume it saw everything.
4. **Exposure** — a UI affordance listing exactly which files were included and how
   many bytes/tokens each consumed, so the user can see and veto the selection
   before the send.
5. **Diagnostics** — extend the existing metadata-only logging with selection stats
   (files considered, included, budget, truncation flag). Still no file contents.

## Acceptance criteria for Step 3

- Selecting context never reads outside the active workspace and never follows a
  symlink out of it (same regression tests as `Workspace`, extended to retrieval).
- A prompt with context still produces exactly one tracked request, with the same
  lifecycle states, and completion is still detected per provider.
- Context assembly is size-bounded: an oversized workspace cannot produce an
  unbounded prompt or an unbounded memory spike.
- The included-file list shown in the UI matches what was actually sent.
- Deterministic tests: scoring/selection, budget truncation, workspace escape,
  empty workspace, binary/large file skipping, and no-context prompts remaining
  byte-identical to Step 2 behaviour.
- Documented limitation: retrieval is lexical, not semantic — it will miss
  conceptually related code that shares no terms.

---

## Implementation record (2026-10-23)

### What shipped

| Plan item | Implementation |
|---|---|
| Bounded local index | `src-tauri/src/context.rs`: one `ignore::WalkBuilder` pass (`.gitignore`, hidden and generated trees skipped), path-sorted candidates, in-memory term counts. No vectors, no index file, no network. |
| Lexical scoring | BM25-style `idf * tf/(tf+1.2)` per query term, plus a file-name/path boost. Lowercase + camel-case splitting, small stopword list, deterministic tie-break by path. |
| Neighbour expansion | **Not implemented.** Import/mod expansion was dropped: it needs per-language parsing, and the plan marked it conditional (“where cheap”). Documented below as a limitation. |
| Budget per provider | `Settings.context` (`web_budget_tokens` 6,000, `local_budget_tokens` 2,500, `max_files` 12), validated 256..=32,000 / 1..=24 and clamped again at use. `Provider::context_kind()` picks web vs local vs manual. |
| Assembly | `agent.rs` prepends the rendered block **before** prior-conversation context and the `TASK:` line. Empty selection ⇒ empty string ⇒ prompt byte-identical to Step 2. |
| Exposure | `ui_context_preview` runs the same `select_for` as the send path and returns metadata only; `ContextPicker` in the composer lists files with line ranges/sizes, allows per-file veto (`exclude`), and can disable context for the task. The agent transcript records the authoritative included list. |
| Diagnostics | `app_log` line `context files= considered= bytes= budget= truncated= scan_capped= omitted= excluded_by_user= binary= oversized= unreadable=` — counts and flags only, never file contents. |

Extra work taken because the plan's acceptance criteria required it:

- Whole-block budget enforcement: if the rendered block would still exceed the
  budget, the last excerpt is dropped and the block re-rendered until it fits, so
  the bound holds even with a long header.
- Excerpt windows: a file that does not fit gets the contiguous line window with
  the most term hits (≤160 lines), with provenance `--- path | lines a-b | N bytes ---`.
- Truncation honesty: `[TRUNCATED — n further matching file(s) were omitted…]`,
  `[SCAN LIMIT …]` and `[SKIPPED — binary/oversized/unreadable/outside …]`, plus
  the same numbers in the transcript note and the composer caveat.

### Verification (actual results)

- `cargo test -p neelima --lib` → **159 passed** (10 new `context` tests: ranking,
  determinism, budget bound, binary/oversized/generated skips, user exclusions and
  rejected exclusion escapes, empty workspace, zero budget, no-match,
  provenance/line ranges, provider-kind budgets, file-name-only match; the
  symlink-escape test is `#[cfg(unix)]` and therefore **did not run on Windows**).
- `cargo test --test agent_loop_e2e project_context` → **passed**: a seeded
  workspace prompt reaches the manual-relay provider with the context block,
  the matching file path and contents, no unrelated file, and the block before
  `TASK:`.
- Full `npm run test:rust` → **183 passed, 0 failed** (159 lib + 2 ACL + 9 agent
  e2e + 12 bridge + 1 emit probe), exit 0.
- `npm run test:ui` → **25 passed** (5 new helper tests, 4 new jsdom render tests
  for `ContextPicker`).
- `cargo fmt --all --check` → exit 0. `cargo clippy --workspace --all-targets` →
  exit 0 (only pre-existing warnings in `spike/` and `browser_bridge_test.rs`).
- `npm --prefix ui run build` → exit 0 (`tsc --noEmit` + Vite).

### Not verified / limitations

- **No live app run in this pass.** The composer panel is render-tested in jsdom,
  not inspected in the running desktop GUI; the preview command was not invoked
  from a signed-in provider session.
- Retrieval is lexical: no semantic match, no cross-file import expansion.
- The composer preview is debounced (450 ms); the transcript entry from the agent
  is the authoritative list of what was actually attached.
- Selecting context sends file text to whichever provider is selected (browser
  chat or local runtime). There is still no per-provider content-consent gate;
  the panel is the consent surface.
