# Neelima project log — 2026-10-20
Current status (2026-11-08): Phase 3P Checkpoints 1–10 are complete. CP3–CP10 are accepted and closed by the
reviewer (CP1 and CP2 are recorded complete in `WORK-LOG-2026-10-19.md`). Checkpoint 10 was accepted after its
isolation and cleanup follow-up (§11). Checkpoint 11 has NOT been started, and completion of Phase 3P is not
completion of the Neelima project. The next activity is the Phase 3P acceptance review — consolidated
limitation register with blocker classification — recorded in §12 below. The checkpoint entries in this file
are kept as historical records, including their pre-acceptance notes; where a heading carried a status word
that has since changed, a historical note records the outcome. Nothing is committed or pushed
(branch `fix/vite-security`, HEAD `320a322`).

## Phase 3P · Checkpoint 3 closeout (entry of record for this checkpoint)
This file is the closeout log referenced at CP3 acceptance review; the full work entry also lives in
`WORK-LOG-2026-10-19.md` (with pre-implementation audit, implementation, live GUI verification and performance
tables). The items requested at the closeout were:

### 1. Log confirmation
- `WORK-LOG-2026-10-19.md`: contains the complete Checkpoint 3 entry (pre-implementation audit, implementation,
  18-item spec mapping, exact lockfile-resolved dependency versions, live GUI verification, performance table,
  CP2-review follow-up status, limitations) plus a dated closeout addendum for the failed-save integration test.
- `NEELIMA_PROJECT_LOG_2026-10-20.md` (this file) did not previously exist; it was created now to carry that
  closeout status — its cannot-be-confirmed-before state is reported honestly here.

### 2. Failed-save integration: now a real executed test, not just structure
- `ui/tests/savePipeline-jsdom.test.js` (new, registered in root `test:ui`): bundles the REAL components —
  FileTree, DiffModal, NativeEditor, the real store, preact and CodeMirror — with the project's own esbuild;
  no new dependencies. The Tauri command layer is stubbed so failure can be injected deterministically.
- Executed flow: dirty draft → "Review & save" → DiffModal opens for `notes.md` → "Apply change" with a
  REJECTING backend (`EPERM: permission denied`) → verified: modal stays open for retry, error toast raised,
  `original` AND `draft` preserved (dirty structural, tab still dirty-marked), one single `fileSave` attempted
  with exactly `("notes.md", <draft>)`, no tabs lost. Then Cancel: no second write, draft intact. Then retry
  with a RESOLVING `fileSave`: modal closes, dirty cleared for exactly `notes.md` (`original === draft` = new
  snapshot), the other open document (`sub/gamma.txt`) untouched, toast `Saved notes.md`.
- Result: `npm run test:ui` = **77/77 pass** (76 prior + 1 new). Rust unchanged; no workspace data touched.
- Honest harness notes: re-render batching is driven by explicit `flush()` calls because jsdom rAF is unreliable
  under CodeMirror's measure loop; CodeMirror emits harmless stderr measurement noise (`textRange getClientRects`)
  that does not affect pass/fail; the esbuild bundle lands untracked in `.tmp/p3q2-save-pipeline/`.

### 3. Checkpoint 3 acceptance summary (unchanged from the previous report)
- Two same-basename tabs with distinct identity; per-document cursor/draft state; hidden-but-mounted views with
  eager disposal (close-all returns tree WS to the no-docs band: 468.5 → 467.3 MiB; idle CPU 0.0 ms everywhere);
  Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+W verified LIVE including trusted WebView2 key dispatch; dirty-close in-app
  confirm; save pipeline draft → DiffModal → `ui_file_save` only, path-routed results; failed save keeps dirty.
- Modified files: `ui/src/editorTabs.ts` (new), `ui/src/store.ts`, `ui/src/components/FileTree.tsx`,
  `ui/src/components/NativeEditor.tsx`, `ui/src/styles.css`, root `package.json`, plus new tests
  (`editorTabs.test.js`, `editorTabs-jsdom.test.js`, `savePipeline-jsdom.test.js`). Rust: none.
  Adapters still 80/80; `tsc --noEmit` clean; production build clean.
- Known limitations: cursor/selection/scroll reset when leaving the Files pane (drafts survive; serialization
  is a CP4 candidate); MAX_DOCS=12 cap; visual polish deferred to 3Q.

Historical note: Checkpoint 4 was held pending reviewer acceptance of this closeout; it was subsequently
accepted. See §11 and the current status header above.

---

## Phase 3P · Checkpoint 4 — Safe file saving and save integrity (2026-10-20)

### 1. Existing pipeline audit (unchanged architecture, strengthened in place)
- Single authoritative path preserved: `FileTree.saveDoc` → `DiffModal.apply` → Rust `ui_file_save` →
  `docsAfterSave` path-keyed routing. No second command, no second filesystem writer, no frontend FS access,
  no alternative approval path, no separate ledger.
- Pre-existing protections confirmed and kept: `ws.resolve` workspace confinement, text-extension allowlist,
  binary-on-disk rejection, 1 MiB edit cap, "No changes to save" no-op guard, sibling temp file + rename.
- Gaps found by the audit: (a) the command received only `(path, content)` — the reviewed baseline was discarded,
  so an external change between review and apply was silently overwritten; (b) the temp file was written with
  `fs::write` and renamed without an explicit flush; (c) success was reported without reading the bytes back.

### 2. Files changed
- `src-tauri/src/ui.rs` — `write_workspace_file(ws, rel, content, expected_original)`; `ui_file_save` accepts
  `expectedOriginal`; conflict marker `SAVE_CONFLICT_PREFIX = "CONFLICT::"`; fsync; pre-rename baseline recheck;
  read-back verification with atomic restore attempt on mismatch; 4 new Rust tests + existing save tests updated.
- `ui/src/tauri.ts` — `fileSave(path, content, expectedOriginal)` sends the reviewed baseline. The parameter is
  REQUIRED as of the CP4 closeout (§11.2); the TypeScript signature no longer accepts an omitted baseline.
- `ui/src/editorTabs.ts` — `SAVE_CONFLICT_PREFIX` mirror + `docsAfterConflictRebase` (rebases `original` onto
  latest disk text, keeps `draft`).
- `ui/src/components/FileTree.tsx` — apply closure sends the document's CURRENT original as baseline (so a
  retry after rebase validates against the reloaded content), catches `CONFLICT::` (string or Error shape),
  reloads the file, rebases the diff and re-throws a plain-language conflict message that keeps the gate open.
- `ui/tests/savePipeline-jsdom.test.js` — 2 new integration tests (conflict + reload + re-review + retry;
  missing destination); existing failed-save test now asserts the baseline argument.
- No UI redesign, no DiffModal change (it already keeps itself open on rejection).

### 3. Rust-side atomicity
- Original CP4 temp sibling `.NAME.neelima-tmp` in the target directory, created with `File::create` +
  `write_all` + `sync_all()` BEFORE the replacement, so a complete, flushed copy exists before the original can be
  displaced. That fixed name was NOT unique per operation; the CP4 closeout (§11.1) replaced it with
  `.{name}.{uuid_v4}.neelima-tmp` + `create_new(true)`, keeping same-directory placement, fsync-before-rename and
  atomic replacement.
- `std::fs::rename` performs the replacement; on any failure the temp file is removed and the original is intact.
- After a successful rename the file is read back and compared with the intended bytes; success is returned only
  on exact match. On mismatch the previous contents (held in memory) are restored via another temp+rename and
  the caller receives an honest failure naming whether the restore succeeded.
- Security preconditions all run before any write: confinement resolve, file-type check, extension allowlist,
  size cap, binary-on-disk scan, no-op guard. Nothing in the Phase 3O execution-integrity verification, approval
  lifecycle or action-ledger path was touched.

### 4. Windows replacement behavior (verified on Windows)
- `std::fs::rename` on Windows is `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)`: an atomic same-volume replace of
  the destination. Unlike Unix `rename(2)`, it REFUSES when the destination carries the read-only attribute or is
  locked (sharing violation) — which is exactly the property the live failure test exploited: the original stayed
  byte-identical and the operation reported `Could not replace file: Access is denied. (os error 5)`.
- Rust test `save_refuses_a_readonly_destination_and_preserves_the_original` proves that on this machine
  (read-only set/cleared with `SetFileAttributesW`): refusal, original preserved, no temp leftover, then clean
  success after clearing the attribute.
- Residual race window: between the pre-rename baseline recheck and the `MoveFileExW` call. Eliminating it would
  require holding an exclusive lock on the destination (which would collide with agents/other editors on the
  same workspace); documented rather than papered over.

### 5. External-modification detection (the CP4 acceptance criterion)
- The editor always sends the exact `original` its reviewed diff was computed against. Inside `ui_file_save`,
  AFTER the temp write and immediately BEFORE the rename, the destination is re-read and byte-compared with that
  baseline (no hashing — exact bytes, collision-free, <=1 MiB). Any difference → refuse with `CONFLICT::…`,
  temp removed, disk untouched. No timestamp comparison anywhere, no silent merge, no silent overwrite.
- Frontend conflict recovery: the refusal is detected (string or Error shape), the latest disk bytes are fetched
  via `ui_file_text`, the document's `original` is rebased onto them while the `draft` stays byte-identical, the
  DiffModal's MergeView rebuilds against the new base, and a plain-language message asks the user to re-check and
  apply again. Re-applying validates against the RELOADED baseline (asserted in the jsdom test).

### 6. Stale drafts
- Drafts are session-memory only (`store.ts` has no persistence; no disk cache of `editorDocs`): an application
  restart cannot resurrect a stale draft — documented, not extended with a new persistence system.
- Workspace switching already drops every document (`editorWorkspaceTag` effect), and saves are path-confined by
  `ws.resolve`, so a draft can never be written into another workspace.
- Within a session, staleness is caught by the baseline check at save time: a stale `original` no longer matching
  disk is a conflict (refused), never an applied draft.

### 7. Tests executed
- Rust: `cargo test` → all binaries green, `file_preview_tests` **15/15** (new: matching-baseline success +
  read-back; external-conflict refusal + both versions preserved + rebased retry; missing destination; Windows
  read-only destination). Existing save tests updated to the new signature.
- Frontend: `npm run test:ui` → **79/79** (77 prior + 2 new: conflict/rebase/re-review/retry, missing destination).
- Adapters: `npm run test:adapters` → **80/80**. TypeScript: `npx tsc --noEmit` (ui) clean. Frontend build:
  `npm run build` exit 0. Tauri: debug binary built (`cargo build`, neelima.exe) and used for the live run below.

### 8. Live runtime verification (real UI + real Rust command, disposable workspace)
- Workspace: `.tmp/cp4-live-failure/ws` (removed afterwards), file `notes.txt`.
- Failure injection: OS-level read-only attribute on the destination (`attrib +R`).
- Observed: apply → real `ui_file_save` rename failed → error toast
  `Could not replace file: Access is denied. (os error 5)` (the actual OS error surfaced through the command);
  DiffModal stayed open on `notes.txt`; tab remained dirty; the draft stayed intact in the editor; the file on
  disk remained exactly `alpha line\nbeta line\n`; no `.notes.txt.neelima-tmp` was left behind.
- After clearing the attribute, re-applying the same reviewed draft succeeded: `Saved notes.txt`, modal closed,
  tab clean, and the on-disk bytes were exactly the intended content (verified byte-for-byte, incl. trailing
  newline; no temp leftovers).
- LIVE EXTERNAL-CONFLICT (acceptance criterion): with the review gate open for `notes.txt`, another process
  appended `EXTERNAL EDIT by another process\n` to the file; the Apply attempt was refused with
  `notes.txt changed on disk since review started. The diff now shows your draft against the latest file — check
  it and apply again.`; the modal stayed open; the tab stayed dirty; the draft stayed intact; the MergeView now
  contained the external line (rebased base = latest disk contents); disk still held the external version and
  none of the draft bytes; no temp leftover. Cancelling the review afterwards kept the draft (`notes.txt●×`).
- Cleanup: disposable workspace removed from app settings, active workspace restored to `inamigos webdev`
  (verified in the running app: "Working in C:\Users\abhi0\Desktop\New folder\inamigos webdev"), app processes
  stopped (count 0), disposable directory deleted, read-only attribute cleared. No commit/push/stash/reset.

### 9. Performance impact
- Cost added per save: one full read of the destination before the rename (baseline recheck), one read after
  (verification), plus `sync_all()` on the temp file. Exact-byte comparison, so no hashing cost.
- Measured on this machine (debug build, ~1 MiB file, 20 saves, alternating content): **~9.97 ms average per save**
  including temp write + fsync + recheck + rename + read-back. Uploaded files are capped at 1 MiB, so the
  absolute cost stays in the single-digit-to-low-teens ms range; `sync_all` (durability) dominates it. Correctness
  was not traded for this.
- No repeated full-file reads are needed elsewhere: the baseline is the document's in-memory `original`.

### 10. Known limitations (honest)
- The compare-then-rename window (see 4) is not zero; eliminating it needs exclusive file locking, deliberately
  not taken because the workspace is shared with agents/editors.
- SUPERSEDED by the CP4 closeout (§11.2): `expectedOriginal` was optional at the command level in the original
  CP4 implementation. It is now mandatory at both boundaries (`String` in Rust, required `string` in TypeScript);
  there is no baseline-free path and no `None` fallback.
- The jsdom failure/conflict tests verify FRONTEND behavior against a stubbed command; they do not verify Rust I/O
  error propagation — that gap is covered by the live run in section 8 instead (and by the Rust tests).
- If the disk changes EXACTLY between the last recheck and the rename syscall, the external change loses; the
  read-back still verifies the bytes that were written and success is only reported on an exact match.
- Conflict recovery intentionally keeps the user's draft and shows the newest disk content as the new base; it
  does not attempt any automated merge of the two.
- Live verification again showed a test-driver artifact: dispatching one trusted press+release pair produced two
  identical toasts in the UI (two click events). The save path itself remained single-attempt (asserted in the
  jsdom test) and no double write occurred (disk verified after each stage).

---

## Phase 3P · Checkpoint 4 closeout — temp-file safety and baseline enforcement (2026-11-06)

Reviewer scope: three targeted follow-ups on the accepted CP4 implementation. No save-architecture redesign and
no unrelated component was touched.

### 11.1 Temporary-file uniqueness (fixed)
- Defect confirmed in the reviewed CP4 implementation: the temp sibling was the FIXED name `.{name}.neelima-tmp`
  in the target directory, created with `File::create`. Two concurrent saves of the same file therefore opened,
  truncated and later renamed/removed the SAME path: one operation could overwrite another's temp bytes, and the
  loser's cleanup could delete the winner's temp file (or its rename would fail with "file not found"). The
  atomic replacement itself was safe, but the temp slot was shared.
- Fix in `src-tauri/src/ui.rs::write_workspace_file`: the temp path is now
  `.{name}.{uuid_v4_simple}.neelima-tmp`, still a SIBLING in the destination directory (same volume, so the
  rename stays atomic), created with `OpenOptions::create_new(true)`. `create_new` is exclusive: it fails rather
  than reusing an existing path, so one operation can never open another's temp file. Cleanup (`remove_file`)
  only ever targets the `temp` path this call created.
- Preserved unchanged: `Workspace::resolve` confinement, the text-extension allowlist, binary-on-disk rejection,
  the 1 MiB cap, the no-op guard, `write_all` + `sync_all()` before replacement, `std::fs::rename` atomic
  replacement, and the post-rename exact read-back verification.
- Dependency: none added. `uuid` v1 with the `v4` feature was already a dependency of the crate
  (`src-tauri/Cargo.toml`).
- Test: `ui::file_preview_tests::concurrent_saves_of_the_same_file_never_corrupt_or_leak_temp_files` — 8 threads
  released together by a `Barrier` save the same file against the same baseline; EXACTLY ONE succeeds (§11.7),
  every loser is a `CONFLICT::` baseline rejection (never an I/O or temp-path error), the final bytes are exactly
  the winner's reviewed draft, and no `*.neelima-tmp` artifact remains.

### 11.2 Mandatory expected baseline (enforced)
- Caller audit (complete): the only caller of `ui_file_save` in the product is `ui/src/tauri.ts::fileSave`, called
  from exactly one place, `ui/src/components/FileTree.tsx::saveDoc` (the DiffModal "Apply change" path). It
  always sends the document's CURRENT `original` (after a conflict rebase, the reloaded baseline), and the jsdom
  pipeline tests assert the third argument on every attempt. No caller needs a baseline-free save, so no
  compatibility bypass was retained and none is documented.
- `write_workspace_file(ws, rel, content, expected_original: &str)` and
  `ui_file_save(..., expected_original: String)` now REQUIRE the baseline: no `Option`, no `None` branch and no
  "compare against what this call just read" fallback. A caller that omits the argument is rejected at the Tauri
  command boundary (required argument), not silently accepted.
- The authoritative check is unchanged and still inside Rust: after the temp write and immediately before the
  rename, the destination is re-read and byte-compared (exact bytes, no hashing) with `expected_original`; any
  difference returns `CONFLICT::…`, removes only this operation's temp file, and leaves the disk untouched.
- `ui/src/tauri.ts` now types the parameter as required; `FileTree.tsx` is unchanged in intent (it already sent it).

### 11.3 Deterministic write-failure recovery test (added)
- `ui::file_preview_tests::save_temp_write_failure_preserves_the_destination_and_leaves_no_artifact` uses a
  thread-local, test-only fault hook (compiled out of production builds) in two modes:
  - mode 1: fail BEFORE the temp file is created;
  - mode 2: fail AFTER the temp file exists with partial bytes, so the cleanup path has a real artifact to remove.
- Both modes assert: `write_workspace_file` returns an honest error (`Could not write file: …`, with no
  `bytes`/`Saved` success payload), the destination is byte-identical to its original contents, no
  `*.neelima-tmp` remains, and the following save still succeeds normally. No environmental assumption
  (permissions, locks, timing) is used.

### 11.4 Durability — what is and is not established
- ATOMIC REPLACEMENT: the destination is swapped by one `std::fs::rename` (Windows:
  `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`; Unix: `rename(2)`), so a reader sees either the old file or the new
  file, never a partially written destination.
- TEMP-FILE `sync_all()`: the temp file is fully written and `File::sync_all()` is called BEFORE the rename, so
  the new bytes (and temp-file metadata) are flushed to the device before the name stops pointing at the old file.
- POST-REPLACEMENT READ-BACK: after the rename the destination is read and byte-compared with the intended
  content; success is returned only on an exact match. On a mismatch the previous bytes (held in memory) are
  written to a temp sibling, synced and renamed back, and the caller gets an honest failure naming whether the
  restore succeeded.
- DIRECTORY-ENTRY DURABILITY: NOT established. Making the rename itself power-loss durable requires syncing the
  containing DIRECTORY after the rename, which `std::fs` cannot do portably (`File::open` on a directory fails on
  Windows, and no directory handle sync exists there). After a sudden power loss the old file can therefore
  return intact even though the new file's contents were synced, and Neelima does NOT claim guaranteed
  power-loss durability of the name swap. This is a documented limitation, not a hidden guarantee.
- COMPARE-TO-RENAME RACE (previously documented, still present): the destination is re-read against the baseline
  immediately before the rename, but without holding an exclusive lock (which would collide with agents/other
  editors on the same workspace) a file can change in the instant between that recheck and the rename syscall.
  That residual window is bounded and documented; it is NOT eliminated. The read-back verification is an honesty
  check for the caller, not a lock, and it does not detect a third party writing immediately after the rename.

### 11.5 Closeout verification (executed 2026-11-06)
- Full Rust suite `npm run test:rust` → exit 0: lib unit tests **260/260**, integration binaries **52/52**
  (acl 2, action_bridge 13, agent_loop 15, browser_bridge 13, emit_probe 1, native_host 8), doc-tests 0 —
  **312 tests, 0 failed**. Log: `.tmp/cp4-closeout-rust-full.log`; lib detail `.tmp/cp4-closeout-rust-lib.log`.
- UI tests `npm run test:ui` → **79/79 pass**, 0 fail (known harmless jsdom/CodeMirror measurement stderr noise).
  Log: `.tmp/cp4-closeout-ui.log`.
- Adapter tests `npm run test:adapters` → **80/80 pass**, 0 fail. Log: `.tmp/cp4-closeout-adapters.log`.
- TypeScript `npx tsc --noEmit` (ui) → exit 0, no diagnostics. Log: `.tmp/cp4-closeout-tsc.log`.
- Production frontend build `npm run build` (ui: tsc + vite) → exit 0, `✓ built in 11.08s`.
  Log: `.tmp/cp4-closeout-build.log`.
- Tauri build `cargo build -p neelima` → exit 0, `target/debug/neelima.exe` produced (debug binary; no installer
  bundle was produced or requested). Log: `.tmp/cp4-closeout-tauri-build.log`.
- Active workspace re-confirmed from the persisted app settings (`%APPDATA%\com.neelima.app\settings.json`):
  `inamigos webdev` → `C:\Users\abhi0\Desktop\New folder\inamigos webdev`.
- Working tree preserved: all pre-existing modifications, logs and `.tmp/` evidence kept; no commit, push, reset,
  stash, branch switch or clean. HEAD is still `320a322` on `fix/vite-security`.

### 11.6 Remaining limitations (closeout)
- Directory-entry fsync is unavailable portably, so power-loss durability of the rename is not guaranteed (§11.4).
- The compare-to-rename race remains against EXTERNAL writers (bounded, unlocked by design) (§11.4, §11.7).
- Fault injection exists only under `#[cfg(test)]`; the test proves cleanup and error honesty, not a real disk fault.
- Conflict recovery still keeps the draft and rebases onto the newest disk content; no automatic merge.
- Same-file save serialization is IN-PROCESS only: another Neelima instance, agent or editor is not serialized.

### 11.7 Final concurrency verification — same-file saves (2026-11-06)

Reviewer finding (confirmed real): the baseline recheck and the atomic replacement are two syscalls. Two saves of
the same file, both carrying the same reviewed baseline, could both observe a match (A checks, B checks) and
then both replace the destination (A renames, B renames) — both report success, and B silently replaces A's
reviewed draft. The previous test only asserted "at least one succeeds" plus a valid final file, so it did not
establish an exclusive winner.

- Implementation: per-CANONICAL-destination-path serialization inside `write_workspace_file`
  (`SAVE_PATH_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>>`). The lock is keyed by
  `std::fs::canonicalize(path)` (fallback: the resolved path) and is held for the whole
  `read baseline → temp write + sync_all → baseline recheck → rename → read-back verify` sequence. A second save
  of the same file waits, then re-reads the FIRST save's bytes as its baseline and is refused with `CONFLICT::…`.
  The registry is process-local and now holds WEAK entries reclaimed after use (§11.8).
- Scope/safety: `Workspace::resolve` still runs before the lock, so workspace confinement is unchanged; approval
  gating (DiffModal) is untouched; the lock grants no filesystem permission and no new path. It does NOT take an
  exclusive OS file lock, so external processes are unaffected and the compare-to-rename race with outside
  writers remains documented and unresolved. There is no claim of filesystem compare-and-swap protection.
- Preserved: unique sibling temp names (`create_new`), own-temp-only cleanup, mandatory `expected_original`,
  atomic replacement, `sync_all()` before the swap, and post-replacement read-back verification.
- Test 1 `concurrent_saves_of_the_same_file_never_corrupt_or_leak_temp_files`: 8 threads released together by a
  `Barrier`, all saving `race.md` with the SAME baseline `base\n`. Asserts **exactly one** `Ok`, every other
  result is a `CONFLICT::` error (no I/O or temp-path error), the final file is exactly the WINNER's draft, and
  no `*.neelima-tmp` artifact remains. Without serialization this assertion is not guaranteed (two threads can
  both match and both rename).
- Test 2 (new, deterministic) `a_stale_save_cannot_overwrite_the_first_successful_save`: after a successful
  save (`base\n` → `first\n`), a second save still carrying `base\n` is refused with `CONFLICT::…`, the disk stays
  exactly `first\n`, and no temp remains; rebasing the same draft onto `first\n` then succeeds. This is exactly
  the state a concurrently-started loser reaches after waiting for the lock.
- Results: full Rust suite `npm run test:rust` exit 0 — **313 tests, 0 failed** (lib **261**, including the new
  test, + 52 integration). UI **79/79**, adapters **80/80** (frontend source unchanged); `cargo build -p neelima`
  exit 0 (debug binary). Logs: `.tmp/cp4-final-concurrency-rust-full.log`, `-rust-lib`, `-ui`, `-adapters`,
  `-tauri-build`.
- Remaining limitation: two separate Neelima processes (or another editor/agent) saving the same file are NOT
  serialized by this in-process lock; the external compare-to-rename race and the absent directory-entry fsync
  (§11.4) remain. The key is the canonical PATH, so hard-linked aliases of the same file are not merged. This is
  an in-process, per-canonical-path guarantee only.

### 11.8 Final lock-registry lifecycle (2026-11-06)

Reviewer finding: the registry stored `Arc<Mutex<()>>` entries that were never removed, so every distinct file
saved left a permanent `PathBuf` + `Arc` in a process-wide map for the life of the process — avoidable growth even
after files and tabs were closed.

- Registry is now `OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>>`. `save_path_lock` upgrades an existing weak
  entry while holding the registry mutex; if no live lock exists it runs `retain(|_, weak| weak.strong_count() > 0)`
  and inserts a new `Arc::downgrade`. The registry guard is released before the caller waits on the per-path mutex;
  the returned `Arc` is kept by `write_workspace_file` for the entire save.
- Why reclamation cannot split operations: a save takes its `Arc` BEFORE any baseline work and keeps it until the
  function returns. While any save of a path is in flight its `Weak` has `strong_count() > 0`, so it always
  upgrades to the SAME mutex; expiry can only happen when no operation holds that path's lock. Derived from the
  registry mutex, so insertion and reclamation cannot interleave with an upgrade.
- Bounded memory: the map now tracks live saves (plus dead entries until the next insertion). Closing tabs or
  finishing saves no longer accumulates lock state.
- Preserved: canonical-path identity, workspace confinement before locking, approval gating, mandatory
  `expected_original`, unique `create_new` temp files, own-temp cleanup, atomic replacement, sync-before-swap and
  read-back verification. External-process race and power-loss limitations are unchanged (§11.4).
- Tests (all in `ui::file_preview_tests`):
  1. `concurrent_saves_of_the_same_file_never_corrupt_or_leak_temp_files` — 8 barrier-synchronized threads with the
     same baseline: EXACTLY ONE `Ok`, every other attempt `CONFLICT::`, final bytes are the winner's draft, no
     temp artifact remains.
  2. `a_stale_save_cannot_overwrite_the_first_successful_save` — deterministic: a stale baseline is refused, the
     first success is preserved byte-for-byte, and the rebased retry succeeds.
  3. `expired_save_path_locks_are_reclaimed` — after a completed save the registry entry is expired (never live),
     and the next new-path lock reclaims it (`save_lock_entry_is_live` → `None`), so entries do not accumulate.
  4. `reclamation_never_splits_a_live_lock` — while an `Arc` is held, a reclamation pass triggered by another
     path's lock still returns the SAME mutex (`Arc::ptr_eq`), so simultaneous saves cannot split onto different
     locks.
- Results: full Rust suite `npm run test:rust` exit 0 — **315 tests, 0 failed** (lib **263**, integration 52); the
  lib suite was also run 3× back-to-back at 263/263 to check the registry tests under parallel execution. UI
  **79/79**, adapters **80/80**; `cargo build -p neelima` exit 0 (debug). Logs:
  `.tmp/cp4-lock-registry-rust-full.log`, `-rust-lib`, `-lib-run-{1,2,3}`, `-ui`, `-adapters`, `-tauri-build`.
- Remaining limitations: in-process only — external editors/agents and other Neelima processes are not serialized;
  the key is the canonical path (hard-link aliases not merged); the external compare-to-rename race and the absent
  directory-entry fsync remain (§11.4).

Checkpoint 4 closeout stopped there; Checkpoint 5 began 2026-11-06 (§12).

## 12. Phase 3P · Checkpoint 5 — File explorer improvements (2026-11-06)

### 12.1 Coordination audit (before editing)

- Branch `fix/vite-security`, HEAD `320a322`; the CP3/CP4 work is uncommitted in the working tree. No reset,
  clean, stash, revert, branch switch, commit or push was performed in this checkpoint.
- Phase 3Q is still plan-only: `docs/PHASE3Q-1-UI-UX-AUDIT.md` exists, but there is no `ui/src/components/ui`
  directory and no shared primitive/token work, so 3Q-2 (design-system + file-manager redesign) has NOT started.
- Shared files identified: `ui/src/components/FileTree.tsx`, `ui/src/styles.css`, `ui/src/editorTabs.ts`,
  `ui/src/store.ts`. Because 3Q-2 had not started, CP5 proceeded with FUNCTIONAL changes only; the visual
  redesign (tokens, primitives, layout, look) remains reserved for 3Q-2.

### 12.2 Audit findings (traced, not assumed)

- The Rust `ui_tree` command stopped reading a directory after 400 entries in OS `read_dir` order and sorted
  only afterwards, so which entries a large folder showed was arbitrary and the truncation was silent.
- The tree had no loading / empty / no-workspace distinction: a slow or failed load looked like an empty folder.
- Refresh reset the whole tree (collapsing expanded folders) and swallowed reload errors.
- A root or directory listing that resolved after a workspace switch could populate the new tree with the old
  workspace's paths; there was no generation guard.
- Rows were clickable only: no roving tabindex, no arrow/Home/End/Enter handling, no tree/treeitem roles.
- Expansion state was mutated in place; there was no pure, testable tree-state layer.

### 12.3 Implementation

- **Rust `list_workspace_dir`** (`src-tauri/src/ui.rs`): sort (directories first, then names) BEFORE applying
  `TREE_ENTRY_LIMIT` (400), so the first page is deterministic; per-entry `read_dir` failures are counted in
  `unreadable` instead of silently dropped; the response now carries `truncated`, `limit` and `unreadable`.
  Dotfiles stay hidden; `file_type()` failures still fail closed as non-directories. Workspace confinement and
  `ui_tree`'s `Workspace::resolve` are unchanged.
- **New pure module `ui/src/fileTree.ts`**: `nodesFromEntries`, `replaceNode`, `applyListing` (root and nested
  merges), `setNodeError` (retryable row), `expandedDirPaths` (root-first, parent-first), `visibleRows`
  (depth + parent), `treeKeyAction` (arrows/Home/End/Right/Left/Enter/Space as intents), `listingMeta` and
  `listingNotice` (honest capped/unreadable copy). No DOM or Tauri dependency.
- **`FileTree.tsx`**: generation-guarded root load and per-directory expansion, so a stale response can never
  enter the current workspace's tree; the previous tree is cleared immediately on a workspace switch; explicit
  `idle | loading | ready | error` states render "No workspace open", "Loading workspace…", "This workspace is
  empty" and a `role="alert"` error banner with a working Retry; Refresh re-walks the root and every successfully
  expanded directory in parent-first order, merging listings without collapsing folders or touching documents /
  previews, and reports failures instead of silently resetting; `role="tree"/"treeitem"`, `aria-level`,
  `aria-expanded`, `aria-selected`, `aria-busy` and one roving tab stop implement keyboard navigation. The key
  handler resolves the row from the event target, not from possibly-stale focus state, and the tab stop falls
  back to the first visible row if a refresh removes the previously focused path.
- **`ui/src/tauri.ts`**: `tree` return type extended with `truncated?`, `limit?`, `unreadable?`.
- **`ui/src/styles.css`**: functional-only styles for `.ft-note`, `.ft-error`, `.ft-row-error`,
  `.ft-row-selected` and `:focus-visible` (deliberately plain; 3Q-2 owns the visual system).
- **Untouched by design**: the CodeMirror editor and multi-tab documents, the DiffModal review gate, the single
  `ui_file_save` save path, mandatory `expected_original`, workspace confinement, approvals and Rust file I/O.

### 12.4 Tests added

- Rust `ui::tree_listing_tests` (2): `listing_is_sorted_directories_first_and_capped_deterministically`
  (406 entries → 400 sorted, dir first, dotfile hidden, `truncated=true`, `limit=400`);
  `empty_and_uncapped_listings_report_accurate_metadata` (empty folder, prefix paths, `truncated=false`).
- `ui/tests/fileTree.test.js` (7 pure tests): node shaping, root/nested `applyListing`, expanded paths order,
  visible rows, keyboard model, retryable failed expansion, listing notices.
- `ui/tests/fileTree-jsdom.test.js` (8 mounted tests): loading vs empty vs no-workspace; failed load + Retry;
  refresh keeps expanded folders and re-walks root-then-directory; capped/unreadable notices; re-expanding a
  loaded folder reuses its listing and the tree does not poll; the roving tab stop follows the tree when a
  refresh removes the focused path; a late response from the previous workspace is discarded; keyboard
  focus/expand/collapse/activate.
- `ui/tests/savePipeline-jsdom.test.js`: harness-only change — it mounted once and re-rendered the root into
  `document.body` to force updates, which appends a second tree under jsdom and doubled mounted components.
  It now mounts once, waits for Preact's mount effects (store subscriptions) to flush, and drives the real UI;
  every assertion (failed save, conflict rebase, missing destination) is unchanged.

### 12.5 Results (actual)

- `npm run test:rust` exit 0 — **317 tests, 0 failed** (lib **265**, integration and other targets 52).
- `npm run test:ui` exit 0 — **94/94** (79 existing + 15 new explorer tests).
- `npm run test:adapters` exit 0 — **80/80**.
- `cd ui && npm run build` exit 0 — `tsc --noEmit` clean and Vite production build succeeded.
- `cargo build -p neelima` exit 0 (debug binary).
- Logs: `.tmp/cp5-rust-full.log`, `-ui.log`, `-adapters.log`, `-frontend-build.log`, `-tauri-build.log`,
  `.tmp/cp5-filetree-tests.log`, `.tmp/cp5-filetree-jsdom.log`, `.tmp/cp5-savepipe-after2.log`.

### 12.6 Measurements

- Mount: exactly **1** `ui_tree` call per workspace; the loading state is shown until it resolves.
- Refresh with one expanded folder: exactly **2** calls (`""` then `src`), asserted in parent-first order;
  folders stay open and new children appear.
- Expand → collapse → expand a loaded folder: exactly **1** listing call total (children are cached in the node);
  a 200 ms idle window adds **0** calls, so no polling/refresh loop was introduced.
- Workspace switch with a pending root request: the stale response is discarded and contributes **0** rows.
- Keyboard state: exactly **1** row is tabbable at any time; when a refresh removes the focused path, the tab
  stop moves to the first visible row instead of leaving the tree unreachable.
- Large folder: enumeration reads 406 entries, returns a bounded, deterministic 400-entry page plus
  `truncated/limit/unreadable` metadata. No wall-clock speedup is claimed; the measured improvement is request
  count and payload bound, not enumeration time.

### 12.7 Remaining limitations

- No virtualization: a capped 400-row page is still 400 DOM rows. Very deep trees are lazy but not virtualized.
- No load-more/paging for capped folders; the notice states the cap (UX/visual work belongs to 3Q-2).
- Refresh is manual — there is no filesystem watcher. External changes are discovered on refresh, and the
  explorer never polls.
- The keyboard model covers focus movement, expand/collapse and activation; there is no type-ahead or
  multi-select.
- `unreadable` counts per-entry `read_dir` failures only; `file_type()` failures are treated as non-directories
  (fail closed) and are not counted.
- Stale-response protection is in-process and generation-based; it does not detect external filesystem changes
  until the next refresh.
- CP4's documented limitations are unchanged: in-process per-canonical-path save serialization only, external
  compare-to-rename race, hard-link aliases not merged, and no guaranteed power-loss durability.

### 12.8 Files changed in CP5

`src-tauri/src/ui.rs`, `ui/src/fileTree.ts` (new), `ui/src/components/FileTree.tsx`, `ui/src/tauri.ts`,
`ui/src/styles.css`, `ui/tests/fileTree.test.js` (new), `ui/tests/fileTree-jsdom.test.js` (new),
`ui/tests/savePipeline-jsdom.test.js` (harness only), `package.json`, this log and `WORK-LOG-2026-10-19.md`.

Checkpoint 5 stops here; Checkpoint 6 is not started. Nothing was committed or pushed.

## Phase 3P · Checkpoint 6 — Agent diffs and approval integration (2026-11-06)

### 13.1 Initial state and coordination

- Branch `fix/vite-security`, HEAD `320a322`; at checkpoint start **35 modified tracked files, 663 untracked
  entries, 0 staged**. All CP1–CP5 work, logs and `.tmp/` evidence were preserved (no reset, clean, stash,
  revert, branch switch, commit or push).
- Phase 3Q remains plan-only: [`docs/PHASE3Q-1-UI-UX-AUDIT.md`](docs/PHASE3Q-1-UI-UX-AUDIT.md) exists, but there
  is still no `ui/src/components/ui`, no shared primitives and no design-token work, so **3Q-2 had not started**.
  CP6 touched `FileTree.tsx`/`styles.css` for FUNCTIONAL behavior only; the visual redesign stays reserved.

### 13.2 Audit findings (traced, not assumed)

- Agent writes already ran through the single `tools::execute` dispatcher after an explicit approval, were recorded
  in the action ledger, and already produced `path/old/new` approval previews keyed by the full workspace-relative
  path (so same-basename files were display-safe). `tools::write_file`/`edit_file` already verify on-disk bytes
  before reporting success.
- Three concrete gaps: (1) an approved call was executed against CURRENT disk content even if the file changed
  after the preview, silently overwriting newer content; (2) nothing told the coding workspace that a verified
  write happened, so the explorer stayed stale; (3) an open CLEAN editor tab kept its old text and old save
  baseline after an agent write to the same path.
- No second writer or approval system was needed: the fix adds a pre-execution baseline guard and a
  post-execution notification around the existing path.

### 13.3 Implementation

- **`src-tauri/src/agent.rs` — stale-preview guard.** For every call in an approval batch, the preview-time
  baseline (`Absent` / exact `Content` / `Unavailable` for >2 MB) is captured BEFORE the preview is built and
  stored under that call's unique approval key. Immediately before `tools::execute` (and after the user's
  approval), the exact bytes are compared again. A mismatch returns `CONFLICT::<path> changed on disk after the
  approval preview was shown…`, records `stale_baseline` in the action ledger, and **never reaches the tool
  executor**, so nothing is written. Later calls in the SAME approved batch are validated against the batch's
  own successful result (refreshed baseline) rather than the pre-batch snapshot; canonical display paths make a
  differently spelled relative path in the same batch still match. `Unavailable` makes no protection claim.
- **`src-tauri/src/agent.rs` — verified `file-changed` event.** Only after a file-mutation tool returns `ok`
  (its own disk read-back passed) is `file-changed` emitted with `workspace`, `task_id`, `call_id`,
  `action_id`, `tool`, canonical `path` and `verified:true`. Refused, rejected, failed, and byte-identical
  writes emit nothing; an append is a real write and is announced, `edit_file` replacing text with itself is
  not. `move_file` announces both paths; `delete_file` announces the removed path. Paths come from
  `Workspace::resolve` + `Workspace::display`, so confinement is the same one the tool used.
- **`src-tauri/src/agent.rs` — review correctness.** Append-mode approval previews now show the real
  post-write content (`old + content`) instead of pretending to replace the file; oversized projections keep
  the existing `[diff … omitted]` form.
- **`src-tauri/src/history.rs`.** `CallRecord.action_id` (optional, `serde(default)`) links each chat call
  record to the ledger action minted for it; old transcripts keep deserializing. Metadata only.
- **`src-tauri/src/action.rs`.** `category::STALE_BASELINE` classifies the refusal.
- **`ui/src/agentChanges.ts` (new, pure).** Validates/refuses unverified `file-changed` payloads; dedupes by
  task/call/path and bounds history to 100; picks the deepest ALREADY-EXPANDED directory containing a change;
  merges a targeted listing while reusing existing nodes (so open folders and loaded grandchildren survive —
  unlike the full-refresh `applyListing`); reconciles one path across all open docs without touching other tabs.
- **`ui/src/App.tsx` / `ui/src/store.ts`.** The store holds the bounded change list plus a tick. An event is
  accepted only for the workspace currently open; a late/replayed event from another tree cannot refresh or
  mark this one. No polling was added.
- **`ui/src/components/FileTree.tsx`.** A verified change marks its row with a provenance dot/title and an
  `aria-label` (full path identity, so two same-basename files stay distinct), refreshes only the containing
  loaded directory (one `ui_tree` call; root change refreshes the root), leaves expansion untouched, reloads a
  CLEAN open tab from disk (and a shown preview), and preserves a DIRTY draft byte-for-byte while warning that
  it will review against the new baseline on save. The tab selection is never changed and unrelated drafts are
  untouched.
- **`ui/src/styles.css`.** Two plain functional rules (`.ft-row-agent`, `.ft-agent-dot`); the 3Q-2 visual pass
  still owns tokens and styling.
- **Preserved by design:** the one `ui_file_save`/`tools::execute` writer, mandatory `expected_original`,
  workspace confinement, approval matching/round keys, exactly-once ledger lifecycle, CodeMirror/multi-tab
  state and the DiffModal review gate. No frontend filesystem access was added.

### 13.4 Tests added

- Rust `agent::tests` (5, lib): `approved_edit_with_stale_baseline_is_refused_without_writing`,
  `approved_edit_writes_through_existing_tool_path_and_verifies_disk`,
  `absent_baselines_and_same_batch_updates_are_handled`, `preview_diff_shows_deleted_content`, and
  `file_changed_events_cover_exactly_the_mutated_paths` (no-op suppression, append, move two paths,
  reads/traversal empty).
- Rust e2e (`src-tauri/tests/agent_loop_e2e.rs`, REAL `agent::run` + real temp filesystem + real approval
  channel + real ledger):
  - `a_stale_preview_baseline_refuses_the_approved_edit_end_to_end` — preview carries `old/new`; an external
    write lands after the preview; approval then yields `CONFLICT::`, the external bytes survive, no
    `file-changed` is emitted, and the ledger says `NotExecuted` / `stale_baseline` with no execution.
  - `an_approved_edit_is_verified_on_disk_and_announced_once` — approval → real disk bytes → exactly ONE
    verified event carrying workspace/task/call/action/path → ledger `Succeeded`, `RustTools`, `had_diff`; a
    duplicate late approval produces no second write and no second event.
  - `same_basename_files_are_approved_and_applied_independently` — one batch, two full-path diffs, two disk
    writes, two ledger records and two change events; no basename merging.
  - `a_rejected_edit_preserves_the_file_and_announces_no_change`.
- UI pure `ui/tests/agentChanges.test.js` (9): verified-shape validation, dedupe/bound, deepest-expanded refresh
  target, expansion-preserving nested/root merge, clean-vs-dirty doc reconciliation across same-basename tabs,
  and provenance text.
- Mounted jsdom `ui/tests/fileTree-jsdom.test.js` (+3): a verified write refreshes only its folder, marks the
  row and dedupes/ignores another workspace; clean tab reloaded + dirty draft preserved + tab selection
  unchanged; root-level change preserves open folders and loaded children. Suite now 11.

### 13.5 Results (actual)

| Check | Result |
| --- | --- |
| `npm run test:rust` | **326 passed, 0 failed** (lib 270; integration targets include the 19-test agent-loop e2e) |
| `npm run test:ui` | **106/106** (94 previous + 12 new) |
| `npm run test:adapters` | **80/80** |
| `cd ui && npx tsc --noEmit` | exit 0 |
| `cd ui && npm run build` | exit 0 (Vite production build) |
| `cargo build -p neelima` | exit 0 (debug) |

Evidence: `.tmp/cp6-rust-full.log`, `-e2e.log`, `-ui.log`, `-adapters.log`, `-tsc.log`, `-frontend-build.log`,
`-tauri-build.log`, `-agent-tests.log`, `-agentchanges-pure.log`, `-filetree-jsdom.log`.

### 13.6 Demonstrated guarantees

- **Only reality reaches the workspace:** 0 `file-changed` events for stale/refused/rejected/failed/byte-identical
  writes; the event fires only after the tool's own read-back succeeded (asserted end to end).
- **Exactly-once per occurrence:** one event per (task, call occurrence, path); a replay is deduped and causes
  0 extra `ui_tree` calls (asserted in jsdom); a duplicate late approval causes 0 extra writes/events.
- **Targeted refresh:** a change under an expanded folder = exactly 1 `ui_tree` call for that folder (not a
  full-tree walk); a root-level change = exactly 1 root call; expansion and loaded children survive.
- **Tab reconciliation:** a clean changed tab is reloaded (1 `fileText`); a dirty changed tab keeps its draft
  and review baseline and produces 1 warning; unrelated tabs and the active tab selection are unchanged.
- **Stale baseline:** an approved call based on older content is refused with `CONFLICT::` and the newer bytes
  remain byte-identical.

### 13.7 Remaining limitations

- The **external-process compare-to-rename race remains**: the baseline is re-read immediately before
  `tools::execute`, but another process can still modify the file between that check and the tool's write. No
  filesystem compare-and-swap guarantee is claimed. (Same class of limitation as CP4.)
- The preview guard applies only when an approval was shown. Under FullAccess, writes execute without a
  preview/baseline by design; files larger than 2 MB are classed `Unavailable` and are not protected.
- `run_command` can change files but cannot be semantically verified; it emits no `file-changed` (the command
  guard and ledger still apply).
- Agent change history is session-only, bounded to 100 entries, and not persisted; markers clear when the
  workspace changes.
- There is still no filesystem watcher: non-agent external changes are discovered by manual refresh. Agent
  changes are event-driven, with one listing call per changed containing directory (no batching across a burst).
- Live automation of the native Tauri window was NOT performed: this environment has no native-window capture/
  input tool. The flow was verified with the real Tauri event-loop e2e harness (real approval channel, real
  filesystem, real ledger) plus mounted jsdom tests, not by clicking the GUI. The active workspace remained
  `inamigos webdev` and was never modified.
- CP4's save limitations are unchanged: in-process per-canonical-path serialization only, external
  compare-to-rename race, hard-link aliases not merged, and no guaranteed power-loss durability.

### 13.8 Files changed in CP6

`src-tauri/src/agent.rs`, `src-tauri/src/history.rs`, `src-tauri/src/action.rs`,
`src-tauri/tests/agent_loop_e2e.rs`, `ui/src/agentChanges.ts` (new), `ui/src/App.tsx`, `ui/src/store.ts`,
`ui/src/components/FileTree.tsx`, `ui/src/styles.css`, `ui/tests/agentChanges.test.js` (new),
`ui/tests/fileTree-jsdom.test.js`, `package.json`, this log and `WORK-LOG-2026-10-19.md`.

Final state: branch `fix/vite-security`, HEAD `320a322`; **36 modified tracked files, 666 untracked entries,
0 staged**, no `*.neelima-tmp` artifacts. Nothing was reset, cleaned, stashed, reverted, switched, committed
or pushed. Checkpoint 6 stops here; Checkpoint 7 was not started.

### 14. CP6 closeout — baseline fail-closed and lifecycle acceptance (2026-11-06)

This section supersedes §13.7's statement that files over 2 MB "are not protected": that behavior was the
review finding and has been changed. No architecture was replaced; the existing approval request, action
ledger, `tools::execute` writer, CodeMirror tabs and DiffModal remain the only paths.

#### 14.1 Exact approval baseline policy

| Preview state | Meaning | Behavior immediately before the executor |
| --- | --- | --- |
| `Absent` | `metadata` returned `NotFound` at preview time | Refused with `CONFLICT::` if the path now exists. |
| `Content(bytes)` | The exact UTF-8 bytes the `old`/`new` preview was computed from | Re-read and byte-compared. Any difference, deletion, or unreadable file is refused with `CONFLICT::`. |
| `Unavailable` | Existing destination over `tools::MAX_DIFF_BYTES` (2 MiB), unreadable/non-UTF-8 bytes, or a metadata error | **Fails closed**: refused with `REFUSED::` before `tools::execute`; ledger `NotExecuted` / `baseline_unavailable`; no execution record, no write, no success event. It is never converted to `Absent` or permission to overwrite. |

- This policy covers the approval-gated content mutations with a preview: `write_file`, `edit_file`, and
  `delete_file`. `move_file` is a separate rename path (no content preview) and is not content-baselined; see
  §14.5.
- Capture happens **before** the preview is built, so the guard can never be weaker than the displayed diff.
- The guard key is the unique per-occurrence approval key, so a re-used model call id cannot inherit an older
  baseline. The recorded path is canonical workspace-display form, so differently spelled same-batch paths merge.
- `FullAccess` is a **separate authorization mode**: when no approval is required, no preview exists and no
  baseline guard is installed. That is unchanged and is not claimed to provide stale-preview protection.
  Approval-gated writes (`AskWrites` and other modes that prompt) always carry one of the three states above, and
  an approval-gated write never proceeds with `Unavailable`.

Unit coverage: `unavailable_baselines_fail_closed_instead_of_overwriting` (lib) proves a >2 MiB file and a
non-UTF-8 file are both `Unavailable`, produce a `REFUSED::…NOT executed…nothing was written` message, and remain
byte-identical; `absent_baselines_and_same_batch_updates_are_handled` covers true absence versus a same-batch
follow-up. End-to-end coverage: `an_unavailable_large_file_baseline_refuses_the_approved_edit` drives the real
agent loop with a 2 MiB+64 file: the approval preview explicitly shows `diff omitted`, approval returns
`ok:false`/`REFUSED::`, the destination is byte-identical, **no `file-changed` event exists**, and the ledger
record is `NotExecuted` / `baseline_unavailable` with `execution: None` (executor never reached).

#### 14.2 Lifecycle acceptance tests (all real-loop unless noted)

- `cancelling_during_approval_writes_nothing_and_a_late_approval_is_ignored` — a pending proposal occupies
  `ActiveAgent` and blocks a workspace switch; `Stop` reaches `Cancelled`, clears `ActiveAgent`, leaves
  `target.txt` byte-identical, and emits no change. An `Approve` sent after cancellation leaves the task
  `Cancelled`, writes nothing, and emits no event.
- `a_pending_proposal_only_touches_its_own_workspace` — with a proposal pending, the workspace switch is refused;
  after approval only the proposal's own workspace changes, while a second workspace containing the same relative
  `target.txt` remains untouched, and the `file-changed` event names the originating canonical workspace.
- `a_failed_write_after_approval_emits_no_success_event_and_allows_recovery` — `blocker` is a file, so an approved
  `write_file` to `blocker/child.txt` fails deterministically after approval: result `ok:false`, no artifact, the
  blocker is byte-identical, and no success event is emitted. The same task can then propose and approve a
  corrected write; only that write is announced, and the ledger records the first attempt `Failed` (no diff) and
  the second `Succeeded`.
- `cancelling a pending review invokes no save and preserves the draft and baseline` (mounted UI, real
  `FileTree` + `DiffModal` + store) — opening "Review & save" performs zero `fileSave` calls; Cancel closes the
  modal, still performs zero `fileSave` calls, keeps the dirty draft and original baseline byte-identical, keeps
  the tab open, and produces no error toast.
- `verified agent writes reload clean tabs and preserve dirty drafts` (mounted jsdom) — a clean tab is reloaded
  from disk while a dirty draft on the same path keeps its exact text and produces the warning; other tabs and
  the active selection are unchanged.
- Existing acceptance cases remain green: stale baseline (lib + e2e), rejection preserves bytes, same-basename
  independence, duplicate/late approval causes no second write or event, and missing approval argument fails
  closed.

#### 14.3 Event and ledger correctness

- A `file-changed` event is emitted only after `tools::execute` succeeded and its own disk read-back passed; the
  event carries workspace, task, call, action, tool, canonical path, and `verified: true`.
- Refused, rejected, cancelled, stale, failed, and byte-identical writes emit none; this is asserted directly in
  the large-file, cancellation, workspace, failed-write, stale, and rejected e2e tests.
- Exactly-once is asserted per call occurrence: a duplicate late approval produces no second write and no second
  event; the UI additionally dedupes `(task, call, path)` and ignores events for another workspace.
- The ledger category is explicit: `stale_baseline` for a changed/deleted baseline and `baseline_unavailable`
  for an uncapturable one; refused records carry no execution.

#### 14.4 Regression results (actual, final sources)

| Check | Command | Result | Evidence |
| --- | --- | --- | --- |
| Rust | `npm run test:rust` | **331 passed, 0 failed** (lib 271; 23-test agent-loop e2e target) | `.tmp/cp6-closeout-rust.log` |
| UI | `npm run test:ui` | **107/107 passed** | `.tmp/cp6-closeout-ui.log` |
| Adapters | `npm run test:adapters` | **80/80 passed** | `.tmp/cp6-closeout-adapters.log` |
| TypeScript | `cd ui && npx tsc --noEmit` | exit 0 | `.tmp/cp6-closeout-tsc.log` |
| Frontend build | `cd ui && npm run build` | exit 0 (Vite production) | `.tmp/cp6-closeout-build.log` |
| Tauri build | `cargo build -p neelima` | exit 0 (debug) | `.tmp/cp6-closeout-tauri-build.log` |

One pre-existing test bug surfaced while running the full Rust suite: `bridge::tests::bridge_hub_is_managed_as_arc`
hardcoded rpc id `"r1"` even though `BridgeHub::begin` allocates ids from a process-global counter; running in
parallel let another test consume `r1`, so the correct nonce resolved an unregistered id. The test now uses the
id returned by `begin` (same assertions, no production change). `src-tauri/src/bridge.rs` is therefore the only
file changed outside the CP6 set in this closeout.

#### 14.5 Remaining limitations

- **External-process race:** the exact baseline is re-read immediately before `tools::execute`, but another
  process can still modify the file between that check and the tool's write. No filesystem compare-and-swap
  guarantee is claimed. Same-process agent calls are already serialized by the task loop.
- **FullAccess:** writes execute without an approval preview or baseline guard by design. It is a separate
  authorization mode and does not inherit the stale-preview protection described above.
- **Large files:** approval-gated writes to files over 2 MiB (and unreadable/non-UTF-8 files) are refused rather
  than reviewed; users must shrink the file or use the editor's review-and-save flow.
- **`move_file`:** approval-gated, but it has no content diff and therefore no `Absent`/`Content`/`Unavailable`
  baseline. The tool refuses an existing destination, so it does not overwrite one; a source that changes after
  preview is moved as-is (bytes preserved, not overwritten), and the destination exists-check-to-rename window
  remains part of the external-process race limitation. No stale-content protection is claimed for `move_file`.
- `run_command` can change files but is not semantically verified and emits no `file-changed`; its guard and
  ledger still apply.
- Agent change history is session-only and bounded to 100; there is no filesystem watcher, and one listing call
  is made per changed containing directory (no burst batching).
- Live native GUI automation was **not** performed in this closeout (no native-window capture tool here). The
  event-loop e2e harness plus mounted jsdom tests are the evidence; no GUI-click claim is made.
- CP4 save limitations are unchanged: in-process per-canonical-path serialization only, external
  compare-to-rename window, hard-link aliases not merged, no guaranteed power-loss durability.

#### 14.6 Files changed in this closeout

`src-tauri/src/agent.rs` (fail-closed baseline + `baseline_unavailable` category use), `src-tauri/src/action.rs`
(new category), `src-tauri/tests/agent_loop_e2e.rs` (four lifecycle e2e tests), `ui/tests/savePipeline-jsdom.test.js`
(pending-review cancellation test + deterministic teardown), `src-tauri/src/bridge.rs` (test-only rpc-id fix), and
both logs. Earlier CP6 files remain as listed in §13.8.

Final state: branch `fix/vite-security`, HEAD `320a322`; **37 modified tracked files, 666 untracked files, 0
staged**, no `*.neelima-tmp` artifacts, active workspace still `inamigos webdev`. Nothing was reset, cleaned,
stashed, reverted, switched, committed or pushed. Checkpoint 6 stops here for review; Checkpoint 7 was not
started.
## Phase 3P · Checkpoint 7 closeout — terminal and output integration (2026-11-06)

Status at entry: CP6 accepted and closed; CP7 was the only checkpoint in scope. All existing modified and
untracked work, including `.tmp/` evidence, was preserved. Nothing was reset, cleaned, stashed, reverted,
switched, committed or pushed.

### 15.1 Preservation and Phase 3Q coordination

- Branch `fix/vite-security`, HEAD `320a322`; no commit or push.
- Phase 3Q remains plan-only: `docs/PHASE3Q-1-UI-UX-AUDIT.md` and its `docs/screenshots/3q1-*` evidence exist,
  but there is no `ui/src/components/ui`, no shared primitives/token layer and no 3Q-2 file-manager redesign.
  **3Q-2 has not started.**
- CP7 therefore did not redesign the terminal or the file explorer. It touched terminal source plus the shared
  command/state wiring it needs. The only `styles.css` additions are `.term-head-actions`, `.term-status*`,
  `.term-retry`; no `FileTree`, editor-tab, DiffModal or file-manager visual rule was changed.
- Shared files inspected but not changed by CP7: `FileTree.tsx`, `NativeEditor.tsx`, `DiffModal.tsx`,
  `editorTabs.ts`, `savePipeline-jsdom.test.js`.

### 15.2 Architecture audit (traced before editing)

The existing stack was reused end to end: xterm.js lazily imported by `TerminalPanel`, a Rust `portable-pty`
session map (`TermState`), Tauri terminal commands, and `term-data` / `term-exit` events through the single
`evt` channel. No second terminal, PTY, command executor, approval path or save path was added. Agent
`run_command` remains its own approval-gated executor and is not mirrored into the visible shell.

Actual deficiencies found and fixed:

1. **Workspace-bound shell survived a switch.** The PTY cwd is fixed at spawn time. `ui_workspace_use` changed
   the workspace slot without touching live terminals, so a shell could remain attached to the previous
   project. The backend now kills all terminal sessions when the canonical workspace root changes.
2. **Create/switch race.** Terminal creation previously cloned the cwd, released the workspace slot, then
   spawned. A switch could complete in that window and the new PTY would register against the old workspace.
   `ui_terminal_create` now holds the workspace slot lock across spawn and registration, so a switch happens
   entirely before creation (new cwd) or after registration (and then kills it).
3. **No child reaping and no exit code.** A PTY reader does not necessarily reach EOF when the child exits
   (ConPTY keeps the pipe alive), and no waiter called `child.wait()`. Natural exits left the session in the
   map and never reported a code. A dedicated waiter thread now reaps the child, reports `Exit { code }` and
   removes the session; the reader thread is independent.
4. **Split UTF-8 corrupted.** Each 8 KiB PTY read was decoded alone, so a multi-byte codepoint split across
   reads became replacement characters. `Utf8Stream` carries at most three trailing bytes forward and flushes
   an invalid tail at EOF.
5. **Pre-connect output and exits were dropped.** The panel attached its listeners only after `termCreate`
   resolved; a fast shell prompt or exit could arrive first. Listeners are registered before creation, events
   are buffered in order, bounded, and replayed by the session id the panel actually owns.
6. **Dispose during creation leaked a PTY.** With listeners now ordered before creation, a panel disposed while
   `termCreate` was in flight would still receive an id. It now kills that id immediately and ignores its events.
7. **No truthful lifecycle UI.** The drawer now distinguishes no workspace, connecting, live, exited with the
   real code, and failure with retry; exit text never invents a code. Input failure is shown instead of being
   swallowed. Restart creates a fresh session and kills the old one.
8. **Emergency-stop lock order.** `emergency_stop` now stops the agent before draining terminals, matching the
   existing `ActiveAgent -> terminal` order used by workspace switch/removal, avoiding a lock inversion.
   Window `Destroyed` already called `TermState::kill_all`; that shutdown path was preserved.

Not changed: workspace confinement, command approval boundaries, exactly-once protections, the CodeMirror
editor/tab model, DiffModal and the mandatory `expected_original` save path, and the embedded provider browser
(as distinct from the user-facing coding workspace).

### 15.3 Implementation

- `src-tauri/src/terminal.rs` — `TermEvent`, `TermState::kill_all` (drain, kill, count), insert-before-reader
  registration, reader/writer error cleanup, incremental UTF-8 decoder, independent child waiter with exit
  code, session removal on exit, `kill`, `write`, `resize`, and shell discovery. Tests below.
- `src-tauri/src/ui.rs` — workspace root-change and active-workspace-removal now call `term.kill_all()`;
  `ui_terminal_create` holds `WorkspaceSlot` across spawn+registration and refuses without a workspace.
- `src-tauri/src/lib.rs` — emergency-stop lock order (`ActiveAgent` first, then terminal). The window
  `Destroyed` kill path remains.
- `ui/src/terminal.ts` (new) — pure event buffer with a **256 KiB UTF-8 target/cap**, not an absolute maximum:
  oldest data is evicted first and an exit is retained, but a single event larger than the cap is kept so the
  only prompt is not discarded. Total retention then equals that one event's byte size; the excess over 256 KiB
  is (event bytes − 262,144). Production PTY events are at most ~24 KiB (8 KiB read worst-case 3× invalid-byte
  expansion), so the exception is not reachable from normal terminal output; the synthetic unit-test event is
  262,145 bytes and demonstrates it. Exit text, workspace label and status text are also here.
- `ui/src/components/TerminalPanel.tsx` — state machine, listener-before-create, per-session replay/filter,
  disposal on workspace change/unmount/restart, input-error status, real exit code, focus, resize observer and
  listener cleanup, single-effect guard against a double spawn.
- `ui/src/styles.css` — terminal-only status/retry/action styles (no visual redesign; 3Q-2 owns that).
- `ui/tests/terminal.test.js`, `ui/tests/terminal-jsdom.test.js` (new) and root `package.json` registration.

### 15.4 Tests

Rust `terminal::tests` (10, real OS processes, no mocking):
`pty_streams_output_and_reports_successful_exit_code`,
`pty_reports_a_nonzero_exit_code`,
`pty_accepts_input_through_the_session_writer`,
`unknown_sessions_report_errors_instead_of_panicking`,
`spawning_a_missing_program_returns_an_error`,
`kill_terminates_the_process_and_reports_exit`,
`kill_all_reaps_every_live_session`,
`lifecycle_timing_is_reported`,
`utf8_stream_preserves_codepoints_split_across_reads`,
`utf8_stream_replaces_invalid_bytes_and_does_not_hold_the_tail`.

Assertions include: real stdout content; exact exit 0 and 7; input echo through the session writer; unknown
session ids return `terminal session not found` for write/resize/kill instead of panicking; a missing shell
returns a spawn error; kill removes the session immediately and still emits its exit; `kill_all` drains both
sessions and both emit `Exit`; a one-byte-at-a-time split preserves `é — 日本語 😀`; invalid bytes become
U+FFFD without retaining state.

Frontend pure tests (8): buffered events stay ordered and byte-bounded; the bound counts UTF-8 bytes rather
than UTF-16 units; an exit event survives trimming even when late data arrives after it; a single oversized
chunk is retained rather than producing an empty queue; exit text reports the real code and never invents one;
workspace labels work for both path styles; status text distinguishes
no-workspace/connecting/live/exited/failure.

Mounted jsdom tests (6, real `TerminalPanel`, real store/Preact, stubbed xterm/Tauri):
no PTY without a workspace; pre-`termCreate` output is replayed; workspace switch kills the old PTY and ignores
its late output; a real exit code is shown and Restart creates a fresh session; a creation failure is reported
and Retry attempts a new PTY; unmounting the drawer kills the session and disposes xterm.

### 15.5 Regression results (final sources)

| Check | Command | Result |
| --- | --- | --- |
| Rust | `npm run test:rust` | **341 passed, 0 failed** (lib 281 incl. 10 terminal, 23 agent-loop e2e and other bins) |
| UI | `npm run test:ui` | **121 passed, 0 failed** (`tests 121 / pass 121 / fail 0`, duration 10.65 s) |
| Adapters | `npm run test:adapters` | **80 passed, 0 failed** |
| TypeScript | `cd ui && npx tsc --noEmit` | exit 0 |
| Production frontend | `cd ui && npm run build` | exit 0, built in 6.42 s |
| Tauri debug build | `cargo build -p neelima` | exit 0, finished in 21.59 s |

Evidence: `.tmp/cp7-rust-full-final.log`, `.tmp/cp7-ui-final2.log`, `.tmp/cp7-adapters-final.log`,
`.tmp/cp7-tsc-final2.log`, `.tmp/cp7-build-final2.log`, `.tmp/cp7-tauri-build-final.log`,
`.tmp/cp7-terminal-tests2.log`, `.tmp/cp7-terminal-ui3.log`. Intermediate logs from the earlier run are kept.

### 15.6 Measurements and limits (no unmeasured speed claim)

- Observed `kill -> Exit` lifecycle: **54 ms**, with **0 sessions** left after exit
  (`.tmp/cp7-terminal-timing.log`). This includes the deliberate 50 ms drain delay before the exit event, so
  the measured kernel kill/wait portion is roughly 4 ms on this machine; it is an observation, not a target or
  an improvement claim.
- One visible PTY per panel; the backend map supports several and `kill_all` drains all. No polling loop or
  interval timer is used for output; events are push-only.
- Pre-session retention has a **256 KiB UTF-8 target/cap with a single-event exception**, xterm scrollback at
  5,000 lines. A single event above the cap is retained rather than discarded; retained total then equals that
  event's size, with excess (event bytes − 262,144). The production event ceiling is ~24 KiB, so normal PTY
  output cannot exceed the cap. The queue cannot grow without bound.
- xterm remains lazy-loaded: production chunk `xterm-B_DfJ2OA.js` = 289.68 kB (72.15 kB gzip), loaded only when
  the drawer is opened.
- No RSS measurement, stress run or before/after responsiveness benchmark was performed, so no memory or
  performance improvement is claimed. The measurements above are lifecycle and bundle observations only.

### 15.7 Remaining limitations

- Only one visible terminal session is exposed; multiple concurrent shells have no UI.
- Output/exit ordering is **best-effort only**: the exit event is emitted after the child is reaped and a 50 ms
  drain, but a very slow reader can still deliver final bytes after the exit marker. Bytes are displayed, not
  dropped. The UI does **not** guarantee that every output byte appears before the exit status.
- Genuinely invalid UTF-8 is replaced with U+FFFD; a codepoint split across reads is preserved.
- Closing the drawer discards scrollback; there is no persistence, reconnect or session restore.
- Shutdown cleanup depends on the window `Destroyed` handler or emergency stop. A hard process kill cannot be
  intercepted, and no native GUI shutdown test was performed.
- Shell strings are split on whitespace, so quoted arguments in a custom shell command remain unsupported
  (pre-existing behavior).
- The visible terminal is user-driven; agent `run_command` is separate and approval-gated, not shown here.
- No live native GUI verification was performed in this closeout. Rust process tests, mounted jsdom tests and the
  Tauri build are the evidence actually collected.

### 15.8 Files changed in CP7

`src-tauri/src/terminal.rs`, `src-tauri/src/ui.rs`, `src-tauri/src/lib.rs`, `ui/src/terminal.ts` (new),
`ui/src/components/TerminalPanel.tsx`, `ui/src/styles.css` (terminal-only additions), `ui/tests/terminal.test.js`
(new), `ui/tests/terminal-jsdom.test.js` (new), root `package.json`, plus both logs.

Final state: branch `fix/vite-security`, HEAD `320a322`; 39 modified tracked files, 107 untracked entries
(670 individual untracked files with `--untracked-files=all`), 0 staged; no `*.neelima-tmp` artifacts; active
workspace still `inamigos webdev`. Nothing was reset, cleaned, stashed, reverted, switched, committed or pushed.
Checkpoint 7 stops here for review; Checkpoint 8 was not started.

## Phase 3P · Checkpoint 8 — test results and execution history (subsequently accepted and closed)

Historical note: this heading previously read "(awaiting review)". CP8 was accepted after the review follow-up
in §8.8 supplied transcript-level evidence for the timeout, cancellation, rejection and ordinary-failure
statuses. Final reported matrix at acceptance: Rust 346, UI 133, adapters 80.

### 8.1 Initial state and preservation

At CP8 entry the workspace was: branch `fix/vite-security`, HEAD `320a322`, 39 modified tracked files,
107 untracked entries (670 files with `--untracked-files=all`), 0 staged. Every existing tracked and
untracked change, both project logs and all `.tmp/` evidence were preserved. No reset, clean, stash,
revert, branch switch, commit or push was performed.

The CP7 log corrections requested before CP8 were applied before implementation: the pre-session terminal
buffer is described as a **256 KiB UTF-8 target/cap with a single-event exception** (not an absolute
maximum), output/exit ordering is described as **best-effort**, and the final CP7 UI count is recorded as
**121** with its exact command output.

### 8.2 Audit — what already existed

The audit traced the existing per-task transcript (`HistoryStore`, one `transcript.jsonl` per task), the
in-memory action ledger, the agent tool-call lifecycle, the `history_open`/`history_list` commands and the
chat tool cards.

Already supported and reused (no second store or execution engine was added):

- Task transcripts persist across navigation, workspace changes and application restart; they are the
  authoritative record for a task.
- Every tool call already persisted `id`, `tool`, `args`, `status`, `output` and (since CP6) `action_id`.
- Statuses already distinguished `ok`, `error` and `rejected`; the action ledger already recorded approval,
  execution, timeout/kill and file-operation outcomes.
- The task list/Search pane can reload a past task; the store then holds its entries and task metadata.
- Tool arguments/output were already rendered as escaped Preact text, never as HTML.

Concrete CP8 deficiencies found:

1. `run_command` persisted **no exit code**; the only record was the human-readable `[exit code: N]` line.
2. Persisted calls had **no start time or measured duration**.
3. The transcript collapsed **timeout, cancellation, refusal, rejection and ordinary failure** into
   `error` (rejection was already separate; refusal/timeout/cancel were not).
4. The action ledger's `ExecutionMeta`/`ActionExecution` had **no exit code**.
5. Execution results were visible only inside chat tool cards; there was **no per-task execution/test list**
   showing status, timing, exit code and bounded output together.
6. Opening a persisted task from Sidebar/Search left the previous live `commandChunks` in the store, so old
   streamed output could be shown as if it belonged to the newly opened task.
7. Legacy transcripts had to remain readable; new metadata needed defaults rather than a migration.

Design limitations, not defects (unchanged):

- The action ledger is **in-memory only**; after restart, `action_id` in the transcript has no corresponding
  live ledger record. The transcript remains the durable history.
- Command output/args are persisted exactly as before. CP8 adds no secret redaction; a command that prints a
  secret still leaves it in the task transcript on disk.
- There is no full-text search across execution output; the list is the last 200 tool calls of the loaded task.

### 8.3 Implementation

- `src-tauri/src/exec.rs` — `RunOutcome` gains `exit_code: Option<i32>` for every terminal path (natural
  exit, timeout, cancel, spawn/wait failure). The CLI output line is unchanged.
- `src-tauri/src/history.rs` — `CallRecord` gains optional, skip-serialized `started_ms`, `duration_ms` and
  `exit_code`; `#[serde(default)]` keeps legacy JSONL readable. Unknown stays `None`, never a fabricated 0.
- `src-tauri/src/agent.rs` — sets the start time only once a call actually reaches an executor, measures
  wall-clock duration around that existing path, stores the real exit code for commands, and maps command
  outcomes to distinct transcript statuses: `ok`, `timed_out`, `cancelled`, `refused`, `rejected`, `error`.
  Rejected and refused calls have no start timestamp, duration or exit code; no process ran. The result passed
  to the model is unchanged.
- `src-tauri/src/action.rs` — `ExecutionMeta` and `ActionExecution` carry the same observed `exit_code` into
  the existing action ledger.
- `ui/src/executionHistory.ts` (new) — pure flatten/dedupe/label/bound helpers over persisted `tool_calls`:
  dedupe by `(entry id, call id)`, last 200 rows, output tail capped at 4,000 characters with an explicit
  truncation marker, optional timing/exit formatting, and status summary counts.
- `ui/src/components/ExecutionHistory.tsx` (new) — renders the loaded task's persisted execution/test results
  with task/workspace attribution, status, duration, exit code, action id, args and bounded output. It is
  mounted in the existing Automations view; no new navigation or store was introduced.
- `ui/src/components/Chat.tsx` — tool cards use the same status labels and show duration, exit code and a
  shortened action id. CP8 did not change approval or diff behavior.
- `ui/src/types.ts` — optional CP8 fields added to `CallRecord`.
- `ui/src/components/Sidebar.tsx`, `SearchPane.tsx` — opening a persisted task now clears `commandChunks`, so
  live output cannot be misattributed to that task.
- `ui/src/styles.css` — execution-history/tool-meta styles only; no visual redesign.
- Root `package.json` — the two new test files registered in `test:ui`.

No file writer, approval path, terminal path, workspace check or `ui_file_save` baseline rule was changed.

### 8.4 Tests added or extended

Rust unit (`src-tauri/src/history.rs`):

- `history::tests::call_execution_metadata_roundtrips_and_legacy_rows_default_to_unknown` — new metadata
  round-trips through JSONL; a **fresh `HistoryStore` over the same root** reads it back (restart-level
  persistence); a pre-CP8 row without the fields deserializes to `None`, not zero.

Rust unit (`src-tauri/src/action.rs`):

- `action::tests::record_serialization_roundtrips_all_variants` — extended so ledger serialization includes
  `exit_code` and survives a full round-trip.

Rust integration (`src-tauri/tests/agent_loop_e2e.rs`):

- `approved_command_output_is_returned_to_provider` — CP8 assertions: persisted call `status == ok`,
  `exit_code == Some(0)`, `duration_ms` present, action id starts with `act-`; the settled ledger record
  carries the same `exit_code == Some(0)`.
- `invalid_tool_args_return_error_result_and_loop_continues` — a refused call persists `status == refused`,
  `started_ms == None`, `duration_ms == None`, `exit_code == None` (no process ran).
- `a_rejected_command_is_not_executed_and_records_no_execution_metadata` — a real approval-gated command is
  rejected; its marker file never appears, the provider sees `rejected by the user`, the transcript persists
  `rejected` with no start/duration/exit, and the ledger records `NotExecuted` with no execution.
- `a_command_that_exceeds_its_timeout_persists_timed_out_status` — a real `node` child outlives a 1 s timeout;
  the provider and transcript both report the timeout, duration is present, ledger outcome is `TimedOut`,
  `process_timed_out` is true, and transcript/ledger exit codes agree (Windows observes taskkill's `1`;
  Unix SIGKILL has no code).
- `cancelling_a_running_command_persists_cancelled_status` — a real child is stopped through
  `AgentCommand::Stop`; the transcript persists `cancelled`, duration is present, output records the tree kill,
  ledger outcome is `Cancelled`, `process_killed` is true, and exit metadata agrees.
- `a_failed_command_persists_error_with_the_observed_exit_code` — a real command exits `3`; the transcript
  persists `error` with `exit_code == Some(3)` and a duration, and the ledger records `Failed` with the same
  observed code.
- Existing rejection/baseline/cancellation tests also guard that no success event is invented.

UI pure (`ui/tests/executionHistory.test.js`, 7 tests):

- flatten/dedupe/task attribution;
- status labels and tones for ok/error/timed_out/cancelled/rejected/refused/running/unknown;
- summary counts including "other";
- tail truncation marker and size bound;
- missing/malformed calls do not become fake successes;
- optional timing/exit formatting is truthful;
- legacy records without CP8 metadata stay readable.

UI mounted jsdom (`ui/tests/executionHistory-jsdom.test.js`, 5 tests, real component/store/Preact, no Tauri):

- persisted calls render with task/workspace attribution, status, duration, exit code and action id;
- all six lifecycle statuses render with distinct labels, and the summary separates success, failure and the
  four warning classes;
- legacy rows render without invented timing/exit metadata;
- hostile command output is rendered as literal text (no `<img>`/`<script>` created, no handler executed);
- an empty transcript has an honest empty state and does not claim a task.

### 8.5 Exact final results

| Check | Command | Result |
| --- | --- | --- |
| Rust workspace | `node scripts/test-rust.mjs --workspace` | **346 passed, 0 failed** (282 lib, 27 agent-loop e2e, others) |
| UI | `npm run test:ui` | **133 passed, 0 failed** (`tests 133 / pass 133 / fail 0`, 10.29 s) |
| Adapters | `npm run test:adapters` | **80 passed, 0 failed** (17.34 s) |
| TypeScript | `cd ui && npx tsc --noEmit` | exit 0 |
| Production frontend | `cd ui && npm run build` | exit 0, built in 9.16 s |
| Tauri debug build | `cargo build -p neelima` | exit 0, finished in 29.66 s |

Evidence: `.tmp/cp8-rust-lifecycle-final.log`, `.tmp/cp8-rust-lib.log`,
`.tmp/cp8-lifecycle-e2e-final.log`, `.tmp/cp8-ui-lifecycle-final.log`, `.tmp/cp8-adapters-lifecycle-final.log`,
`.tmp/cp8-tsc-lifecycle-final.log`, `.tmp/cp8-build-lifecycle-final.log`,
`.tmp/cp8-tauri-lifecycle-final.log`, `.tmp/cp8-hist-pure.log`, `.tmp/cp8-hist-jsdom-final.log`,
`.tmp/cp8-timeout-test.log`, `.tmp/cp8-cancel-test.log`, `.tmp/cp8-history-test.log`. The jsdom UI log
contains the known CodeMirror measurement noise (`textRange(...).getClientRects is not a function`); it did
not fail a test.

### 8.6 Persistence and its actual guarantees

- Durable source: the existing per-task `transcript.jsonl`. CP8 fields are written to it; a new store instance
  over the same root reads them back (tested). No database or storage architecture was introduced.
- The UI list is derived from the loaded task's entries, so it survives restart only after the user opens that
  task from history; there is no global execution index.
- The action ledger is memory-only: `action_id` remains a durable correlation key, but the ledger record itself
  is gone after restart. No claim is made that ledger lifecycle survives restart.
- Output is bounded in the view (last 200 rows, 4,000-character tail), while the full capped tool result stays
  in the transcript per the existing `result_cap_bytes` policy.
- HTML safety comes from Preact text escaping (tested); no new sanitizer or HTML rendering path was added.
- No performance improvement is claimed. CP8 did not add polling, timers or background work.

### 8.7 Remaining limitations

- No live native GUI verification was performed. Evidence is Rust tests, mounted jsdom tests and builds.
- The ledger remains in-memory; no ledger history across restart.
- No secret redaction in persisted output/args (pre-existing transcript behavior); sensitive output can be
  exposed to anyone who can read the task history.
- Command timeout/cancel may record the terminated child's real wait code alongside the distinct
  `timed_out`/`cancelled` status; the status is authoritative, the code is reported as observed and is not
  claimed to be a clean application exit.
- The history view shows the loaded task only (last 200 calls); cross-task aggregation and output search are not
  implemented.
- Very old transcripts have no timing/exit data and render those fields as absent.

### 8.8 Review follow-up — lifecycle evidence

The review correctly noted that the first CP8 report listed only `ok` and `refused` evidence. The four missing
cases were added as real-process integration tests (not relabelled fixtures), and the UI mounted suite now
renders all six statuses. This follow-up also tightened semantics: `started_ms` is now set only when a call
actually reaches an executor, so rejected/refused records carry no start timestamp at all.

Focused evidence:

| Test | Runtime | Assertion core |
| --- | --- | --- |
| `a_rejected_command_is_not_executed_and_records_no_execution_metadata` | in full e2e | marker absent, `rejected`, no start/duration/exit, ledger `NotExecuted` |
| `a_command_that_exceeds_its_timeout_persists_timed_out_status` | 3.09 s | `timed_out`, duration present, `TimedOut`, `process_timed_out`, Windows exit `1` |
| `cancelling_a_running_command_persists_cancelled_status` | 2.73 s | `cancelled`, duration present, tree-kill output, `Cancelled`, `process_killed`, Windows exit `1` |
| `a_failed_command_persists_error_with_the_observed_exit_code` | in full e2e | `error`, exit `3`, duration, ledger `Failed` exit `3` |
| All-six-status mounted UI test | `ui/tests/executionHistory-jsdom.test.js` | six labels; summary 1 success / 1 failure / 4 warnings |

On Windows the forced `taskkill` path makes the observed shell code `1`; the tests assert that exact value.
The Unix branch expects `None` for a SIGKILL death, but only the Windows branch was executed in this
environment. No timeout-specific code is invented.

### 8.9 Final state

Branch `fix/vite-security`, HEAD `320a322`; 42 modified tracked files, 111 untracked entries (675 files with
`--untracked-files=all`), 0 staged; no `*.neelima-tmp` artifacts. All prior modifications, logs and `.tmp/`
evidence were preserved. Nothing was reset, cleaned, stashed, reverted, switched, committed or pushed.
Checkpoint 8 stops here for review; Checkpoint 9 was not started.

## 9. Phase 3P Checkpoint 9 — Editor-to-Agent Context Sharing

CP9 started from the CP8 closeout with no CP9 implementation present. The existing editor could copy text
manually, but there was no explicit way to attach the active editor buffer or a selected code range to a
prompt.

### 9.1 Initial state and coordination

- Branch `fix/vite-security`, HEAD `320a322`, 0 staged.
- 42 modified tracked files and 111 untracked entries (675 files) were already present; every one was
  preserved. Five new CP9 source/test files were added later (see 9.7).
- No Phase 3Q file-manager redesign had started; CP9 deliberately avoided the 3Q-2 visual scope and only
  added a compact control/row to the existing composer/editor surfaces.
- The live app was not run and no workspace setting was changed. The previously recorded active workspace
  remains `inamigos webdev`; all CP9 tests use isolated fixtures/stubs.

### 9.2 What already existed

- `src-tauri/src/context.rs` already performs prompt-derived automatic project-context selection, with a
  backend budget and transcript metadata. It reads workspace files from disk.
- The composer already supports local file/PDF/DOCX/image attachments through `attachments.ts`; those are
  copied into the prompt and are unrelated to open editor documents.
- The native editor keeps multi-tab `DocRec` drafts in the store (`editorDocs`, `editorActivePath`,
  `editorWorkspaceTag`) and CodeMirror views stay mounted per document.
- The agent had no access to the active editor file, the current selection/cursor, open tabs or unsaved
  drafts. `ContextPicker` could display and veto automatic disk context, but could not explicitly share an
  editor buffer or range.

### 9.3 Concrete deficiencies fixed

1. No explicit way to add the active editor file to a prompt without copying text.
2. No way to share one selected range with accurate path/line metadata.
3. Automatic context could re-read the same file from disk, so a user sharing an unsaved draft could send
   two contradictory versions (the explicit draft and a stale disk copy).
4. No visible/removable pending editor attachment, and no clear source/scope label.
5. Workspace/task changes needed an explicit lifecycle so an old tree's context could never be sent.

No second editor, agent, file-access subsystem, approval path or save path was added.

### 9.4 Implementation and user flow

New `ui/src/editorContext.ts` is the pure contract:

- One attachment per `(workspace, canonical path)`. A newer whole-file or range capture through the same
  editor supersedes the earlier one.
- A range is captured from the live draft with `from`/`to` in that same draft; `startLine`/`endLine` are
  recomputed from those offsets. Stale labels supplied by a caller are ignored.
- Whole-file capture is bounded at 24,000 characters per item by keeping complete leading lines. The item is
  marked `truncated` and the prompt says exactly which later lines were not included.
- A selection over the per-item limit is refused, never cut. A whole file whose first line alone exceeds the
  limit is also refused: it has no line boundary at which it could be shortened honestly.
- The per-prompt caps are 6 items and 48,000 total characters. Re-adding the same target replaces it (latest
  capture wins). There is no tokenizer claim: these are character/byte bounds, while automatic context keeps
  its existing backend budget.
- `formatEditorContext` emits one explicit `[EDITOR CONTEXT …]` block in the USER message. The payload is a
  single-line JSON object; every path, label and file body is a JSON string value. Newlines, quotes and
  fence/role-like markers in file text are escaped, so content cannot end the block, forge a file header or
  start a new physical line. The surrounding notice says the strings are untrusted data, not instructions, and
  not a source of system rules, permissions, approval gates or workspace boundaries. This is ROLE/DATA-PATH
  ISOLATION, not a guarantee against prompt injection: the model can still choose to follow hostile text it
  reads as data. No system/developer role is created by the editor block.

New `ui/src/editorContextCapture.ts` reads the live selection:

- Locates the mounted `.doc-editor` wrapper for the canonical path.
- Uses `EditorView.findFromDOM` on the real CodeMirror view; the plain-textarea fallback is supported.
- A collapsed or invalid selection returns `null` (the caller shares the whole buffer). Offsets are validated
  against the exact draft supplied by the caller, so a stale view cannot point outside the text.

UI wiring:

- `FileTree.tsx`: a compact code-icon button in the Files header shares the ACTIVE editor. It reads the
  current `DocRec.draft` (never `fileText`/disk), captures a selection when one exists, attaches it, and brings
  the composer forward with a toast. The tooltip states that a selection is used, otherwise the whole file.
- `Composer.tsx`: a second `composer-plus` control opens an "Open editor files" menu. Each row shows the file
  name, directory and unsaved marker. Selecting one attaches the current draft. Attached items render above
  the prompt as removable rows with path, scope (whole file / selected lines / truncation), buffer source,
  size and an explicit Remove button.
- Minimum needed state: `store.ts` adds `editorContexts`; `resetTask()` clears it. `App.tsx` clears it when
  the active workspace changes. The actual final race guard is in the composer/send path: items are filtered
  by the current `activeWorkspacePath` immediately before display and send.
- On send, automatic project context receives the attached paths in its `exclude` list in both the debounced
  preview and the task-start context. The explicit editor block supplies the draft/range itself.
- A web-provider send with explicit editor context asks for confirmation, like the existing attachment path.
  After an accepted task the attachments and text are cleared. A failed task start restores the user's own
  text and the same attachment items; the textarea is never filled with the formatted context block.
- Ordinary chat (no editor context) constructs exactly the same user text as before.

### 9.5 Workspace, buffer and security guarantees

- The item stores its workspace; only items matching the current active workspace are displayed or sent.
  A task reset and a workspace change clear the pending list. The send path filters again as the final guard.
- The source is always `DocRec.draft` captured by the explicit share action. No attachment path calls
  `fileText`/`filePreview`; the on-disk original is used only to compute the `unsaved` marker.
- This is a SNAPSHOT AT SHARE TIME, not a live subscription. If the user edits the same buffer after sharing
  and before sending, the attached item still contains the share-time bytes; the row/label now says "at share
  time". The user must remove/re-attach to send a newer edit. This is an intentional, visible limitation.
- Attached paths are excluded from automatic disk context, preventing the stale-disk duplicate described above.
  They are not removed from the workspace or from unrelated automatic matching.
- The block is untrusted user data placed in the task's USER message. It is never interpolated into a
  system/developer message, cannot add provider roles or messages, cannot alter tool schemas, approval policy or
  workspace confinement, and no new file read/write or approval bypass exists. The editor save path and
  mandatory `expected_original` baseline are untouched. Text framing and role isolation reduce structural
  escape; they do not make the model immune to instructions embedded in file content.

### 9.6 Tests added

Pure model (`ui/tests/editorContext.test.js`, 13): whole-file draft/unsaved/byte metadata; range line metadata
recomputed from the real draft; collapsed/mismatched/out-of-range selections; oversized range refused;
complete-line whole-file truncation; empty buffer; single over-limit line refused; per-workspace+path
replacement; count/total caps; removal/workspace filtering; structured data-only prompt payload; hostile
delimiter/role/fence collisions; truncation wording.

Mounted composer (`ui/tests/editorContext-composer-jsdom.test.js`, 12, real Composer/store, Tauri stub):
no implicit attachment of open docs; current unsaved draft sent and its path excluded from automatic context;
removal before send; workspace switch hides/send-blocks another tree's item; debounced preview excludes the
path; ordinary chat unchanged; `resetTask` clears; multiple files attach independently; no-doc/no-workspace
menu states; failed start restores attachment and user text; web-provider confirmation; truthful truncation
row.

Real CodeMirror selection (`ui/tests/editorContext-selection-jsdom.test.js`, 2): live range selected through
`EditorView`, exact text/line metadata from the unsaved draft; collapsed selection shares the whole current
buffer. jsdom needs `Range.getClientRects`/`getBoundingClientRect` stubs for CodeMirror measurement; these do
not affect selection offsets.

Total new: 27 tests. Full UI suite: 160/160 (previous 133 + 27).

Security follow-up Rust tests: `providers::tests::hostile_editor_context_serializes_as_one_user_message`
(real `send` state and exact serialized request body: one message, one `user` role, escaped newlines) and
`agent_loop_e2e::hostile_editor_context_stays_in_the_task_user_message` (real agent loop + manual provider:
one outbound prompt, hostile block only after `TASK:`, one real closing marker).

### 9.7 Files

New:

- `ui/src/editorContext.ts` — pure model, caps, replacement, workspace filter, prompt framing.
- `ui/src/editorContextCapture.ts` — live CodeMirror/textarea selection capture.
- `ui/tests/editorContext.test.js`
- `ui/tests/editorContext-composer-jsdom.test.js`
- `ui/tests/editorContext-selection-jsdom.test.js`

Modified:

- `ui/src/components/FileTree.tsx` — share-active-editor control and capture call.
- `ui/src/components/Composer.tsx` — editor menu, attachment rows/removal, send formatting, exclusion,
  web confirmation, failure restore.
- `ui/src/store.ts` — `editorContexts` state and task-reset cleanup.
- `ui/src/App.tsx` — clear pending items on workspace change.
- `ui/src/styles.css` — compact menu/row styles only (no 3Q redesign).
- `package.json` — register the three new UI test files.
- `NEELIMA_PROJECT_LOG_2026-10-20.md`, `WORK-LOG-2026-10-19.md` — this record.

No Rust production file changed for CP9's feature. The security follow-up adds only Rust tests in
`src-tauri/src/providers.rs` and `src-tauri/tests/agent_loop_e2e.rs`; no executor, approval or save code changed.

### 9.8 Exact final results

| Check | Command | Result |
| --- | --- | --- |
| Rust workspace | `npm run test:rust` (`node scripts/test-rust.mjs --workspace`) | **348 passed, 0 failed** (283 lib, 28 e2e, others) |
| UI | `npm run test:ui` | **160 passed, 0 failed** |
| Adapters | `npm run test:adapters` | **80 passed, 0 failed** |
| TypeScript | `cd ui && npx tsc --noEmit` | exit 0 |
| Production frontend | `cd ui && npm run build` | exit 0, built in 8.63 s |
| Tauri debug build | `cargo build -p neelima` | exit 0, finished in 14.74 s |

Focused evidence: `.tmp/cp9-followup-editorContext.log` (13/13), `.tmp/cp9-followup-composer.log`
(14/14 including the real CodeMirror selection suite). Full matrix: `.tmp/cp9-followup-rust.log`,
`.tmp/cp9-followup-ui.log`, `.tmp/cp9-followup-adapters.log`, `.tmp/cp9-followup-tsc.log`,
`.tmp/cp9-followup-build.log`, `.tmp/cp9-followup-tauri-build.log`. The older CP9 logs remain as evidence
for the pre-follow-up implementation. The pre-existing jsdom CodeMirror measurement noise
(`textRange(...).getClientRects is not a function`) appears in the full UI log from the older save-pipeline
suite but did not fail any test.

### 9.9 Remaining limitations

- No live native GUI verification was performed. Evidence is pure/mounted jsdom tests with real CodeMirror and
  the full builds; the native window, focus behavior and OS clipboard were not exercised.
- Editor context is a share-time snapshot, not a live binding. Edits after sharing require remove/re-attach;
  the UI now says "at share time" to make this explicit.
- Attached context is text only (whole buffer or range). Binary/image handling remains the existing local
  attachment path, not a new editor-binary path.
- The caps are characters/bytes, not exact model tokens. Automatic project context retains its separate
  backend budget; explicit context does not claim to participate in that token accounting.
- Automatic context still scans unrelated workspace files from disk; only the explicitly attached paths are
  excluded. A user who shares one file does not disable automatic context for the rest of the workspace.
- The menu lists at most the existing open-document cap (12); no file picker was added to this surface.
- No performance improvement is claimed. Attachment building is synchronous and only on explicit action/send;
  no polling or background editor reads were introduced.

### 9.10 Final state

Branch `fix/vite-security`, HEAD `320a322`; 43 modified tracked files, 116 untracked entries (682 files with
`--untracked-files=all`), 0 staged; no `*.neelima-tmp` artifacts. All prior modifications, logs and `.tmp/`
evidence were preserved. Nothing was reset, cleaned, stashed, reverted, switched, committed or pushed.
CP9 stops here for review; CP10 was not started.

### 9.11 CP9 security follow-up — framing correction and provider evidence

The previous CP9 record overstated the guarantee. Plain-text `--- path ---` fences and a line-based
`[END EDITOR CONTEXT]` marker can be reproduced by a file's own contents, so "cannot change system rules" was
not a defensible claim. That wording is corrected in 9.4 and 9.5 above. The guarantee is now stated precisely:
editor text is isolated to the user-message DATA PATH; it is not interpolated into a system/developer message;
the framing does not make prompt injection impossible.

`formatEditorContext` now emits exactly four physical lines:

1. `[EDITOR CONTEXT — N attachment(s), N characters — explicitly shared by the user]`
2. A notice that the next line is one JSON object whose content values are untrusted file text.
3. One JSON object: `{ kind: "neelima.editor-context", version: 1, note, attachments: [...] }`.
4. `[END EDITOR CONTEXT]`.

Every attachment's `path`, labels and `content` are JSON string values. JSON escaping means file text cannot
introduce a physical newline, closing fence, fake file header, `<|system|>` role marker or `SYSTEM:`/`DEVELOPER:`
line. U+2028/U+2029 are additionally escaped. A file cannot add an `attachments` entry: it only supplies a
string. This eliminates structural escape from the data block. It does not prevent the model from choosing to
follow hostile sentences it reads as data — that remains a prompt-injection risk, bounded only by the existing
approval gates, tool validation, workspace confinement and the surrounding untrusted-data notice.

Regression tests added (no production Rust behavior changed):

- `src-tauri/src/providers.rs::tests::hostile_editor_context_serializes_as_one_user_message` — calls the real
  `LocalProvider::send` with a payload containing the exact closing delimiter, fake context headers, a
  `"role":"system"` JSON fragment, `<|system|>`, role lines and an exfiltration instruction. Asserts the queued
  state is exactly one message with role `user`; the serialized `local_request_body` contains exactly one
  `"role":"user"`, no system/developer role, one message, the hostile text unchanged as `content`, no literal
  newline on the wire, and `\n`-escaped hostile line breaks.
- `src-tauri/tests/agent_loop_e2e.rs::hostile_editor_context_stays_in_the_task_user_message` — drives the real
  agent loop and manual provider. Asserts one outbound prompt; the editor block begins after `TASK:`; the prompt
  ends with the exact task text; the hostile `SYSTEM:` line appears once; only one physical
  `[END EDITOR CONTEXT]` line exists. The task then completes with `DONE`.
- `ui/tests/editorContext.test.js` — 13 tests now, including parsing the emitted JSON and a hostile fixture with
  closing markers, fake block headers, role lines, `<|system|>`, a fenced JSON attempt and an injection
  instruction. Asserts four physical lines, one real closing marker, no role/header line at line start, one
  attachment and byte-exact hostile content in the JSON value.
- `ui/tests/editorContext-composer-jsdom.test.js` — the mounted send test and multi-file test now parse the
  actual `taskStart` message, proving the exact draft bytes/paths reach `attachments[].content` and that two
  same-basename paths remain distinct.

Results (exact commands, all exit 0):

| Check | Result |
| --- | --- |
| `npm run test:rust` | 348 passed, 0 failed (283 lib, 28 e2e, 13 adapter, 2 contexts, 13 history, 8 protocol, 1 other) |
| `npm run test:ui` | 160 passed, 0 failed |
| `npm run test:adapters` | 80 passed, 0 failed |
| `cd ui && npx tsc --noEmit` | exit 0 |
| `cd ui && npm run build` | exit 0, built in 8.63 s |
| `cargo build -p neelima` | exit 0, finished in 14.74 s |

Focused evidence: `.tmp/cp9-followup-rust-focused.log`, `.tmp/cp9-followup-rust-e2e.log`,
`.tmp/cp9-followup-editorContext.log`, `.tmp/cp9-followup-composer.log`. Full matrix:
`.tmp/cp9-followup-rust.log`, `.tmp/cp9-followup-ui.log`, `.tmp/cp9-followup-adapters.log`,
`.tmp/cp9-followup-tsc.log`, `.tmp/cp9-followup-build.log`, `.tmp/cp9-followup-tauri-build.log`.

Limits of this evidence: the Ollama/LM Studio wire body is proven by the provider unit test; the manual relay
is proven by the e2e test. The embedded browser provider sends the same single user text through its page
adapter and has no separate editor/system channel, but that page path was not independently serialized in this
follow-up. No native GUI verification was performed. Prompt injection is not claimed to be impossible.

## Phase 3P Checkpoint 10 — Integration and acceptance

### 10.0 Scope

CP10 audits the Phase 3P workflow as one system (editor, tabs, explorer, save/diff approval, verified agent
writes, terminal, execution history, editor-to-agent context, chat/task lifecycle) and performs native GUI
acceptance on a disposable workspace. No working component was redesigned, and no accepted checkpoint was
reopened without a demonstrated defect. CP11 was not started.

### 10.1 Repository state

Recorded before any CP10 edit: branch `fix/vite-security`, HEAD `320a322`, 0 staged, 43 modified tracked files,
and the CP5–CP9 untracked evidence preserved. Those values were re-verified rather than assumed. The untracked
count grew only because CP10 added its own `.tmp/cp10-gui/` evidence tree (including a WebView2 CDP profile).

### 10.2 Disposable workspace lifecycle (exact definition)

The acceptance run must never touch the user's real project or the real application profile. The lifecycle
that was actually used:

1. **Location.** Fixtures live inside the repository's evidence directory:
   `.tmp/cp10-gui/workspace` (files `alpha.ts`, `beta.ts`, `notes.txt`, `src/`) and
   `.tmp/cp10-gui/workspace-two` (`two.ts`, `src/`). `.tmp/` is repository-local, ignored by the product and
   not part of the user's workspaces (`inamigos webdev` and `task1`).
2. **Creation.** `.tmp/cp10-gui/setup-workspace.js` and `add-workspace-two.js` write the fixtures and register
   them through the acceptance app's own `ui_workspace_add`/`ui_pick_workspace` path — no direct settings file
   editing.
3. **Isolation.** The GUI under test is a debug build made with
   `--config .tmp/cp10-gui/tauri.acceptance.conf.json`, which changes only `productName`
   (`Neelima CP10 Acceptance`) and `identifier` (`com.neelima.cp10acceptance`). Tauri derives the config
   directory from the identifier, so the run reads/writes `%APPDATA%\com.neelima.cp10acceptance\`
   (`settings.json`, `tasks/`, `adapters/`) and never `%APPDATA%\com.neelima.app\`. The WebView2 profile is
   redirected with `WEBVIEW2_USER_DATA_FOLDER=.tmp/cp10-gui/webview-acceptance`, and CDP attaches only through
   the test-only `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9334`.
4. **Use.** All acceptance actions run in that window: workspace fixtures, edits, saves, approvals, terminal,
   history, context sharing. The real application was never started during acceptance.
5. **Evidence.** Every run writes logs/DOM dumps under `.tmp/cp10-gui/` (`acceptance-build*.log`,
   `acceptance.out.log`, `ui.log`, `adapters.log`, `rust*.log`, `tauri-build.log`, plus the CDP scripts).
6. **Teardown.** The window is closed with its own Close control (a graceful shutdown, which also proves no
   orphaned terminal child survives). Fixtures and evidence are intentionally left in `.tmp/` as CP10 evidence;
   nothing outside the repository is deleted. The acceptance config directory is disposable and is not removed
   during the checkpoint so the evidence stays reproducible.
7. **Invariant.** The user's real workspace files and `%APPDATA%\com.neelima.app\settings.json` are unchanged.

**Incident disclosure.** The first GUI attempt used a debug build that still carried the real
identifier, so adding the disposable fixtures appended them to the user's real workspace list. This was
detected by comparing the real settings file against `.tmp/cp10-gui/settings.backup.json`. The instance was
stopped, the backup was restored byte-for-byte (`cmp` reported identical, `active_workspace_id` back to
`inamigos webdev`), and acceptance was rebuilt and re-run under the separate identifier above. This is why the
lifecycle requires an identifier-level isolation, not just a disposable folder.

### 10.3 Integration audit — concrete defects and fixes

Three real integration defects were found by exercising the assembled workflow. Everything else that was
audited already behaved correctly and was left alone.

1. **A saved document still claimed an unsaved draft.**
   `ui/src/fileEdit.ts::editStatus` always appended `unsaved draft`. After "Review & save" → Apply, the draft
   equals the new baseline but the footer kept saying `unsaved draft`, contradicting the tab dot and the disk.
   Fix: the label is now `saved` when `draft === original`, otherwise `unsaved draft`; the size/line delta logic
   is unchanged. Test: `ui/tests/savePipeline-jsdom.test.js` asserts the footer after a real save contains
   `saved` and not `unsaved draft`.
2. **Verified agent writes were lost while the Files surface was unmounted.**
   Change reconciliation lived only in `FileTree` component state, so a write that arrived while the user was on
   Chat was dropped: on remount the explorer showed no marker and a clean tab kept stale text. Fix: the handled
   change keys now live in the session store (`agentHandledKeys` in `ui/src/store.ts`), `FileTree` seeds its
   handled set from the store and reconciles only the changes it has not yet processed. Nothing polls. Test:
   `ui/tests/fileTree-jsdom.test.js` mounts, unmounts, delivers a change event, remounts, and asserts the row
   marker plus a clean-tab reload.
3. **A workspace switch left the previous workspace's task on screen.**
   After switching projects, the chat kept the finished transcript of the other tree under the new workspace
   name. The backend already refuses a switch while a task is active and refuses to continue a task from another
   workspace (`select the workspace used by this task before continuing it`), so the UI was the only place the
   two could disagree. Fix: new pure module `ui/src/workspaceSwitch.ts`
   (`workspaceSwitchClearsTask`, `clearedTaskView`) used by the existing workspace-change effect in
   `ui/src/App.tsx`. It clears the task association (entries, taskId, openTask, pendingCalls, command chunks,
   streaming text, diff, relay text, agent state) while deliberately preserving the unsent composer draft and
   leaving editor-context clearing to its existing CP9 effect. Tests: `ui/tests/workspace-switch.test.js`
   (startup is not a switch; same path is not a switch; a different path is; the patch contains no
   `composerText`/`editorContexts`), registered in `npm run test:ui`.

Audited and found already correct (no change): multi-tab drafts and tab switching; save → diff → Apply → disk
with baseline; approval/rejection routing; terminal creation, output, and kill on workspace change; history
attribution and exit codes; explicit editor-context attach/remove/clear; ordinary chat without context.

### 10.4 Native GUI verification actually performed

Performed on the isolated acceptance build, driving the real window (WebView2 via CDP; no human visual review
of pixels). Checks 1–11 of the CP10 list:

| # | Check | Observed |
| --- | --- | --- |
| 1 | Open workspace, create/edit multiple files | Files view listed and opened `alpha.ts`, `beta.ts`, `notes.txt`; edits made through CodeMirror input |
| 2 | Switch tabs, drafts remain | Independent drafts survived tab switches (CP6/cp10 draft-tab run) |
| 3 | Save file, verify diff/approval and disk | `Review & save` → diff modal → Apply; disk bytes equaled the editor, toast `Saved alpha.ts` |
| 4 | Agent file change → event, explorer, tab behaviour | Write proposed by a real manual-relay task, approved, verified on disk; Files was unmounted at the time; on remount the row showed `Open alpha.ts (changed by the agent)` and the clean tab reloaded to the new 41-byte content with footer `saved` |
| 5 | Terminal command and workspace switch | `echo CP10_TERM_OK` printed in the panel; old PTY pid 5752 disappeared on switch, a new PTY (15212) started with cwd `...\workspace-two` |
| 6 | Execution history: attribution, status, duration, exit code | Scope `CP10 acceptance catch-up · workspace`, row `write_file · succeeded · 3 ms`; second run scope `Current session · ...\workspace`, row `run_command · succeeded · 84 ms · exit 0` |
| 7 | Share current buffer and a selected range | Attach editor context produced items for the whole draft and for a selected range |
| 8 | Remove an attachment before send | Removed item disappeared from the pending list and was absent from the task message |
| 9 | Switch workspace with pending context | Pending editor context cleared; nothing from the old tree was sent |
| 10 | Ordinary prompt without editor context | Chat started and ran normally with no editor block |
| 11 | Close/reopen and inspect persistence | Active workspace `workspace-two` restored from settings; no editor tabs and no terminal reattached; task transcripts and history remained available |

Shutdown cleanup: closing the window exited `neelima.exe` and left no `pwsh.exe` child.

### 10.5 Regression matrix (exact commands, all exit 0)

| Check | Command | Result | Log |
| --- | --- | --- | --- |
| Rust workspace tests | `node scripts/test-rust.mjs` | 348 passed, 0 failed (283 lib, 28 e2e, 13 adapter, 13 history, 8 protocol, 2 contexts, 1 other) | `.tmp/cp10-gui/rust-full.log` |
| UI tests | `npm run test:ui` | 165 passed, 0 failed | `.tmp/cp10-gui/ui.log` |
| Adapter tests | `npm run test:adapters` | 80 passed, 0 failed | `.tmp/cp10-gui/adapters.log` |
| TypeScript + production frontend | `npm --prefix ui run build` | exit 0, built in 5.55 s | `.tmp/cp10-gui/frontend-build.log` |
| Tauri debug build | `./ui/node_modules/.bin/tauri build --debug --no-bundle` | exit 0, finished in 23.08 s | `.tmp/cp10-gui/tauri-build.log` |
| Acceptance debug build | same command + `--config .tmp/cp10-gui/tauri.acceptance.conf.json` | exit 0 | `.tmp/cp10-gui/acceptance-build4.log` |

The UI count rose from 160 (CP9) to 165: four `workspace-switch` tests plus the mounted remount/save assertions
added with defects 1 and 2.

### 10.6 Security and data-integrity review

- Workspace confinement and approval gates are unchanged; agent writes still go through the single
  `ui_file_save` path with `expected_original`, and the verified disk write is what the UI reports.
- The catch-up write proved the ordering requirement: the row marker and tab reload happened only after
  `wrote 41 bytes to alpha.ts [41 bytes, content verified on disk]`, not from the agent's claim.
- Terminal PTYs are killed on a real workspace-root change and on shutdown (observed both), and the PTY is
  spawned in the workspace root (observed cwd).
- Transcript history is durable per task, while the action ledger stays in memory; the history view renders the
  persisted status/duration/exit values.
- Editor context remains JSON-encoded inside one user message; CP10 adds no new framing and does not claim
  prompt-injection immunity.
- No boundary was weakened to make an integration check pass.

### 10.7 Remaining limitations

- GUI acceptance was driven through CDP with a test-only remote-debugging port; it is not a human visual review
  of layout, typography or motion, and Phase 3Q's visual redesign remains untouched.
- The acceptance binary differs from the shipping binary only by product name/identifier, but it is that build
  that was exercised.
- Terminal process cleanup and exit codes were verified on Windows only; the Unix signal path remains covered by
  unit tests, not by a live run.
- The terminal retains a 256 KiB target/cap with a single-event overshoot, and output/exit ordering stays
  best-effort (CP7 wording).
- The file explorer still caps a directory listing at 400 entries with no load-more (CP5 limitation).
- Recent tasks are listed globally, not per workspace. Opening one from another workspace displays it, but
  continuing it is refused by the backend with an explicit message (verified), so this is a UX limitation rather
  than a confinement hole.
- Editor tabs/drafts and terminal sessions are not persisted; a restart restores the active workspace and the
  durable task transcripts only.
- Approval-gated writes to files whose baseline cannot be captured (>2 MiB) remain refused by design.
- `.tmp/cp10-gui/` evidence, including a WebView2 profile, is untracked and intentionally left in place.

### 10.8 Final state

Branch `fix/vite-security`, HEAD `320a322`; 0 staged; 43 modified tracked files; 118 untracked entries
(1391 files with `--untracked-files=all`, of which 707 are CP10 evidence). No reset, clean, stash, revert,
branch switch, commit or push was performed. CP10 stops here for review; CP11 was not started.

---

## CP10 Follow-up — Disposable Workspace Isolation and Cleanup Verification (2026-11-08)

Review status at start of this follow-up: CP10 implementation provisionally accepted; three isolation
accounting items open (fixtures inside the repository, real-settings restoration not independently accounted,
fixture cleanup not performed).

### 11.1 Defect confirmed

The CP10 acceptance fixtures had been created at `.tmp/cp10-gui/workspace` (65 files) and
`.tmp/cp10-gui/workspace-two` (27 files) — inside the repository, in the directory that is supposed to hold
retained evidence only. The agreed lifecycle required the disposable workspaces to live under the OS temporary
directory. Fixture data (including app-generated `.neelima/checkpoints.git`) had therefore been mixed with
evidence.

### 11.2 Pre-conditions verified

- Acceptance application closed: `Get-Process neelima` → 0 processes.
- No stray PTY children: cmd.exe/powershell.exe/conhost.exe with a command line under
  `cp10-gui\workspace` → 0.
- OS temporary directory: `C:\Users\abhi0\AppData\Local\Temp`.

### 11.3 Relocation to the OS temporary directory

Fixtures were copied to uniquely named directories under the OS temp root (timestamp token
`20261108T173250`), with per-file counts checked before the in-repo copies were removed:

| Fixture | Temp path | Files copied |
| --- | --- | --- |
| alpha | `C:\Users\abhi0\AppData\Local\Temp\neelima-cp10-20261108T173250-ws-alpha` | 65 of 65 |
| beta | `C:\Users\abhi0\AppData\Local\Temp\neelima-cp10-20261108T173250-ws-beta` | 27 of 27 |

Canonical paths (`os.path.realpath`) confirmed:

- `...\Temp\neelima-cp10-20261108T173250-ws-alpha` — exists, under OS temp: yes, inside repository: no.
- `...\Temp\neelima-cp10-20261108T173250-ws-beta` — exists, under OS temp: yes, inside repository: no.
- Neither path appears in any user workspace registration (see 11.5).

A SHA-256 manifest of both relocated trees was written to `.tmp/cp10-gui/fixture-manifest.txt`
(92 file hashes) and the canonical paths to `.tmp/cp10-gui/relocated-paths.txt`, so the fixture contents
remain auditable after deletion.

### 11.4 Cleanup

Deleted, after the path-prefix guard confirmed each target:

- `C:\Users\abhi0\AppData\Local\Temp\neelima-cp10-20261108T173250-ws-alpha`
- `C:\Users\abhi0\AppData\Local\Temp\neelima-cp10-20261108T173250-ws-beta`
- `.tmp\cp10-gui\workspace` and `.tmp\cp10-gui\workspace-two` (the misplaced in-repo copies)

Verification: all four paths report `exists=False`; no `%TEMP%\neelima-cp10-*` entry remains.
Evidence preserved: `.tmp/cp10-gui` file count went from 746 to 654 (exactly the 92 fixture files removed);
every log, script, screenshot/DOM dump, build log, settings backup, acceptance config and WebView2 profile
remains.

### 11.5 Real application settings — restoration accounting

- Backup file: `C:\Users\abhi0\Desktop\New folder\zodecpy\.tmp\cp10-gui\settings.backup.json`
- Real settings file: `C:\Users\abhi0\AppData\Roaming\com.neelima.app\settings.json`
- Backup SHA-256: `493aa1f8154ee9d6dc075b4bd0dfe1d3af2f69c99b20018fb93a3b70cb4c3e4a`
- Current SHA-256: `493aa1f8154ee9d6dc075b4bd0dfe1d3af2f69c99b20018fb93a3b70cb4c3e4a`
- Byte-for-byte comparison: identical.
- `active_workspace_id` = `7ed94b22ec534773825ca4710d51921e` → `C:\Users\abhi0\Desktop\New folder\inamigos webdev`.
- Six workspace registrations; none contains `cp10acceptance`, `.tmp/cp10-gui`, or `neelima-cp10-`, so no
  acceptance workspace remains registered.

The real settings file was read for hashing and field inspection only; it was not written again in this
follow-up.

Pre-existing, non-CP10 registrations are present in the backup itself and were left untouched:
`neelima-live-test-29197831996a44a1b719c0eee05f857b` (earlier live test),
`.tmp/ws3f`, `.tmp/p3n-ws`, `.tmp/phase3o-live-acceptance` (earlier checkpoints). They pre-date CP10 and are
not acceptance artifacts of this checkpoint.

### 11.6 Isolated acceptance test config

`%APPDATA%\com.neelima.cp10acceptance\settings.json` (test-only, separate identifier) still references the two
removed fixture paths. It is not user configuration and is not read by the shipping app; it was left as-is
because the acceptance application was intentionally kept separate. A future acceptance run would need to
re-register fixtures.

### 11.7 Final state

Branch `fix/vite-security`, HEAD `320a322`; 0 staged; 43 modified tracked files; 118 untracked entries
(1303 files with `--untracked-files=all`, down from 1391 by exactly the removed fixture files). No reset,
clean, stash, revert, branch switch, commit or push. CP10 stops here for review; CP11 was not started.

---

## 12. Phase 3P Final Acceptance Audit — status, limitation register, blocker classification (2026-11-08)

Read-only audit. No source file was modified, no test was re-run today, and nothing was committed. Evidence for
every statement below is the checkpoint record already in this file (section references given per item) and in
`WORK-LOG-2026-10-19.md`.

### 12.1 Checkpoint status

| CP | Scope | Status | Record |
| --- | --- | --- | --- |
| 1 | Architecture audit and performance baseline | complete | work log §1443 |
| 2 | CodeMirror 6 editor integration | complete | work log §1583 |
| 3 | Multi-tab editor and save pipeline | accepted | §1–3 |
| 4 | Safe file saving and save integrity (+ closeout) | accepted | §4–11.8 |
| 5 | File explorer improvements | accepted | §12 |
| 6 | Agent diffs and approval integration (+ closeout) | accepted | §13–14 |
| 7 | Terminal and output integration (+ closeout) | accepted | §15 |
| 8 | Test results and execution history (+ follow-up) | accepted | §8, §8.8 |
| 9 | Editor-to-agent context sharing (+ security follow-up) | accepted | §9, §9.11 |
| 10 | Integration and acceptance (+ isolation follow-up) | accepted and closed | §10, §11 |

Phase 3P is closed as a checkpoint series. It is not the completion of the Neelima product: the provider/browser
surface, automations and marketplace views were outside 3P scope, and the visual redesign (Phase 3Q) has not
started.

Last executed regression matrix (2026-11-08, unchanged sources since): Rust 348, UI 165, adapters 80, TypeScript
clean, production frontend build pass, Tauri debug build pass.

### 12.2 Consolidated limitation register

Every item below is already documented at its checkpoint; this is the single register, not new findings.

**Persistence and session state**

- L1 The action ledger is memory-only. `action_id` remains a durable correlation key in the transcript, but the
  ledger record itself does not survive restart. (§8.6, §8.7)
- L2 Editor tabs/drafts and terminal sessions are not persisted. A restart restores the active workspace and the
  durable per-task transcripts only. (§10.7)
- L3 Verified agent-change markers are session-only, bounded to 100 entries, and cleared on workspace change.
  (§13.7)
- L4 Closing the terminal drawer discards scrollback; no reconnect or session restore. (§15.7)

**Verification coverage**

- L5 CP3–CP9 were not individually verified in a native window. CP10 exercised the assembled workflow in the real
  desktop window, but through CDP — there was no human visual review of layout, typography or motion. (§10.7,
  §15.7, §8.7, §9.9)
- L6 Live terminal kill/reaping evidence is Windows-only; the Unix signal path is covered by unit tests, not a
  live run. (§15.7, CP8 closeout)
- L7 The acceptance binary differs from the shipping binary only by product name and identifier, but that is the
  build that was exercised, on a separately identified app-data profile. (§10.7)

**Functional limits**

- L8 A directory listing is capped at 400 entries with an explicit truncation notice and no load-more. (§12.7)
- L9 There is no filesystem watcher. Non-agent external changes are found on manual refresh; the explorer never
  polls. Agent changes are event-driven. (§12.7, §13.7)
- L10 One visible terminal session; multiple concurrent shells have no UI. Custom shell strings are split on
  whitespace, so quoted arguments are unsupported (pre-existing). (§15.7)
- L11 Approval-gated writes to files whose baseline cannot be captured (>2 MiB) are refused before the executor
  rather than executed unprotected. (§14)
- L12 FullAccess is a separate authorization mode: it applies no preview-baseline protection by design, and is
  documented as such rather than presented as equivalent. (§13.7, §14)
- L13 Editor context is a share-time snapshot, text-only, capped in characters/bytes (not model tokens); automatic
  project context still scans other workspace files from disk. (§9.9)
- L14 The history view shows the loaded task only (last 200 calls); no cross-task aggregation or output search;
  very old transcripts render missing timing/exit fields as absent. (§8.7)
- L15 The terminal retains a 256 KiB target/cap with a single oversized-event exception, and output/exit ordering
  is best-effort, not guaranteed. (§15.7)

**Security and data-integrity residuals**

- L16 The external compare-to-rename window in saving is not zero; eliminating it would need exclusive locking,
  deliberately not taken because the workspace is shared with agents and editors. (§10)
- L17 Power-loss durability of the rename is not guaranteed (no portable directory fsync). (§11.4)
- L18 Same-file save serialization is in-process only; another Neelima instance, agent or editor is not
  serialized, and hard-link aliases are not merged. (§11.6, §12.7)
- L19 Persisted transcript output and tool arguments are not secret-redacted (pre-existing policy): anyone who can
  read a task transcript can read what a command printed. (§8.7)
- L20 Prompt injection from untrusted editor/file content remains possible in the semantic sense. JSON framing and
  user-message placement prevent structural escape into other roles; they do not prevent the model from being
  persuaded by hostile text. (§9.11)

### 12.3 Blocker classification

**A. Confirmed release blockers: none.** Every defect found during CP4–CP10 was fixed and covered by an executed
test or a live check; no checkpoint closed with a failing suite.

**B. Must be decided or explicitly accepted by the project owner before a public release**

1. L19 — secret material in local transcripts. Acceptable if the threat model is "local user's own machine, same
   trust level as the files themselves"; not acceptable if transcripts are ever uploaded, shared or synced.
2. L6 — platform coverage. A Windows-only release is consistent with the evidence; a macOS/Linux release is not,
   because the live terminal-kill path was never executed there.
3. L11 — refusing approval-gated writes above 2 MiB is safe but is a product decision: it blocks a legitimate
   editing case rather than protecting it. Either accept the refusal or schedule a bounded exact-baseline
   mechanism.
4. L5/L7 — a release with no human visual pass would be unusual, but visual acceptance belongs to Phase 3Q's final
   acceptance, not to Phase 3P.

**C. Deferred, scheduled for later phases**

L8 and L9 (explorer paging and watcher; natural 3Q-2 follow-ups), L10 (multi-session terminal UI), L13 (snapshot
semantics wording), L14 (history aggregation), L2/L3 (persistence polish), L15 (cap/ordering wording). None of
these break an existing workflow; each has a visible limitation notice or documented behavior.

**D. Accepted risks, documented, no action planned**

L16, L17, L18 (inherent to a shared, cross-process workspace and the platform), L12 (deliberate FullAccess mode),
L20 (residual with mitigations: dedicated user-message data path, approval gates, workspace confinement).

### 12.4 Stale test configuration (recorded on reviewer instruction)

The isolated acceptance test configuration `%APPDATA%\com.neelima.cp10acceptance\settings.json` still lists the
two CP10 fixture workspaces that were relocated to the OS temporary directory and then deleted:
`.tmp\cp10-gui\workspace` and `.tmp\cp10-gui\workspace-two` (both `exists=False`).

This is stale test configuration only. The shipping application uses the separate identifier `com.neelima.app`,
whose settings file contains no CP10 registration (verified §11.5). A future acceptance run must re-create and
re-register its fixtures; those paths must not be mistaken for existing workspaces.

Four older registrations in the real settings file pre-date CP10 and were left untouched, as instructed:
`neelima-live-test-29197831996a44a1b719c0eee05f857b` and `.tmp/ws3f`, `.tmp/p3n-ws`,
`.tmp/phase3o-live-acceptance`. They are inside the pre-CP10 backup itself. They deserve a separate audit — at
least one temp-directory path may no longer exist — but they are not Phase 3P regressions and no CP10 change
created them.

### 12.5 What this audit did and did not do

- Did: verify the checkpoint record, reconcile status wording with outcomes, consolidate the limitation corpus,
  classify items by release impact, record the stale test configuration.
- Did not: change source, re-run tests, re-open a closed checkpoint, or claim any verification beyond the reported
  evidence.
- Working tree preserved exactly: no reset, clean, stash, revert, branch switch, commit or push.

### 12.6 Final state

Branch `fix/vite-security`, HEAD `320a322`, 0 staged, 43 modified tracked files, 118 untracked entries
(1303 files with `--untracked-files=all`). Phase 3P acceptance audit complete; Phase 3Q not started.

---

## 13. Phase 3Q-1 — current-state UI design audit (2026-11-08)

Analysis only: no source, stylesheet, component, dependency or persisted setting changed. The full document is
`docs/PHASE3Q-1-DESIGN-AUDIT-2026-11-08.md`; the 2026-11-04 audit remains the historical record and is not edited.

### 13.1 Evidence actually collected

The real debug build was rebuilt with the acceptance config, launched with a dedicated WebView2 profile and a
test-only CDP port against a disposable fixture workspace under the OS temp root (9 files, 2 nested dirs), and
driven through seven surfaces. Each capture asserted its DOM state first; assertions are in
`.tmp/3q1-audit/walkthrough.json`, captures `01-home` … `07-automations-history.png`. Measured in the running app:
viewport 1123×702 CSS px, rail 72 px, main panel 1027 px, terminal drawer 962×151.

The fixture was deleted after capture and the instance was closed; 0 `neelima` processes and 0 stray shells
remained. The shipping `com.neelima.app` profile was never opened.

### 13.2 What the 2026-11-04 audit got wrong about today's app

It described a textarea editor, no diff gate, no tabs and no execution history — all of that predates CP2–CP10.
The current workspace has CodeMirror, multi-tab drafts, the diff-gated save, honest explorer states, terminal
lifecycle and persisted execution history. Its shell/chat/settings findings still hold.

### 13.3 Confirmed defects (high severity)

- **`.btn-yes` has zero CSS rules** (2 uses, 0 declarations) while `.btn-no` has 4. The diff-gated primary
  action renders as bare text and the secondary as a pill — the affordance inversion is a missing rule, not a
  style preference. Evidence: `04-editor-tabs.png`, `03-file-preview.png`.
- **The workspace wastes the desktop**: 272 px explorer inside a 1027 px content column, ~755 px empty, and the
  editor covers the explorer as a centred modal instead of occupying the space.
- **No markdown, no code blocks, no copy** in assistant messages; tool args/output are silently sliced at
  400/4,000 chars.
- **14 `window.confirm` call sites** across six components, alongside modals and toasts.
- **Token discipline is nominal**: 699 literal hex colours and 69 `rgba()` literals against 127 `var(--…)` uses;
  two `:root` blocks; 20 radii, 19 font sizes and 14 gaps with no scale.
- **Diff panes are unlabelled**; verification/verdict text is styled as system chatter.

### 13.4 Deliverables produced

Inventory (§2), evidence inventory (§1), defects with evidence (§3), direction (§4), token spec (§5), component
inventory (§6), file-manager specification (§7), layout recommendations (§8), accessibility plan (§9), prioritised
3Q-2…3Q-10 plan (§10), compatibility constraints K-1…K-11 (§11), open questions (§12).

### 13.5 Recommendation carried forward

Approve the visual system and implement the shared foundation (3Q-2) before touching screens. 3Q-2 should fix
tokens, primitives, the missing `btn-yes` rule and native confirms **without** changing layout, so a regression is
attributable. The proposed file manager is a docked two-pane split with a terminal dock, not a modal editor.

Open decisions: docked vs modal editor, light-theme re-capture, whether `btn-yes` was a bug, settings reopen tab,
paging vs virtualisation, single vs multiple terminal sessions.

### 13.6 Final state

Branch `fix/vite-security`, HEAD `320a322`, 0 staged, 43 modified tracked files. No commit, push, reset, clean,
stash, revert or branch switch. Phase 3Q-2 not started.

### 13.7 Revision R1 — user feedback (2026-11-08, same day)

The user approved the visual direction but rejected the emphasis: Neelima needs a usable Files workflow, not a
visual overhaul. The 3Q-1 document was revised in place (§3 rows W-9…W-12, §7 rewritten, §10 resequenced,
§12 replaced, K-12 added). Still analysis only.

**Interaction audit (code-verified, not appearance):**

- A row click calls `toggle()`; for a file that is not yet open it fetches `ui_file_preview` and opens the modal.
  There is no selection step, so nothing on screen responds before the overlay covers the tree.
- `onDblClick` and `onContextMenu` do not exist in `FileTree.tsx` (0 matches each). `Enter`/`Space` route to the
  same `toggle`, so the keyboard has no way to open the editor directly either.
- `.ft-row-selected` is applied to the previewed file, but the modal hides it — the only selection feedback is
  structurally invisible.
- The header "share" control captures the **active editor document** (CP9), so "use this file in chat" cannot be
  reached from the tree without first opening the editor.
- Backend supports exactly: preview (`ui_file_preview`), read (`ui_file_text`), save with mandatory baseline
  (`ui_file_save`). There is **no** rename, delete, create-file, create-folder or per-file reveal command, so the
  revised menu offers only Open in editor / Preview / Copy path / Share with chat.

**Revised direction:** left-docked resizable explorer, editor in the content area with tabs above it, preview as an
editor-pane state instead of a modal, terminal docked and resizable, persistent selection with distinct hover /
selected / focused / active-tab states, and an explicit "Select a file to preview · double-click to open" empty
state. §10 now begins with 3Q-2a (tokens + primitives + the missing `.btn-yes` rule) and 3Q-2b (the docked file
workspace) before any chat, settings or decorative work.

Unaffected: workspace confinement, the diff gate, editor drafts, agent-change handling, explorer honesty, terminal
lifecycle and history attribution all remain as constrainted in §11 (now including K-12: selection never discards a
dirty draft).

---

## 2026-11-08 — Phase 3Q-2a: UI foundation (tokens, primitives, button hierarchy)

User decisions (recorded before implementation): preview is an editor-pane state; ~120 ms debounce with a session
cache invalidated on save / verified agent write / explicit refresh / workspace switch; a selected-but-not-open
file is shared from disk and labelled "On disk" while open documents keep sharing their draft; rename, delete,
new file/folder, per-file reveal and drag/drop stay deferred until Rust commands exist; `.btn-yes` missing is a
confirmed bug; capture light theme before freezing tokens; one terminal session, persisting dock height but never
process state.

Scope honoured: this checkpoint is the foundation only. No layout, file-manager, chat, Automations or settings
redesign. No new runtime dependency, no CSS-in-JS.

**Delivered**

- Semantic token layer in `styles.css`, derived from the eight `--theme-*` values (surfaces/lines/text, 4 px
  spacing scale, type scale, five radii, two durations, elevation and a shared focus ring). `theme.ts` still
  accepts exactly the original eight themeable names, so custom themes need no migration.
- `uiPrimitives.ts` + `components/ui/{Button,IconButton,Panel,EmptyState,StatusChip}` — thin wrappers over existing
  class names, so adoption is markup-neutral and cannot move geometry. `DiffModal`'s Apply is the only adopter.
- `.btn-yes` now has a rule (filled accent, hover, disabled, focus ring). `Review & save` and `Apply change` are
  the visually primary actions.
- App-wide reduced-motion support (previously only the easter egg honoured it).

**Second defect found while verifying the first.** `.btn-no` is declared twice — a dark `#33343b` rule and a later
unconditional light `#f0eef6` — so in dark theme the "secondary" action rendered as a bright light pill and
out-shouted the new primary. A scoped `[data-theme="dark"] .btn-no` restores the dark secondary the file already
intended; colour only, geometry untouched. Verified in the live app: primary `rgb(89,102,216)`, secondary
`rgb(51,52,59)`, both `5px 14px` / 8 px radius.

**Measurement correction.** The 3Q-1 audit said the explorer is 272 px. The effective rule is
`width: min(100%, 720px)`; the live tree measures 720 × 591 inside the 1027 px panel, leaving ~307 px empty. The
audit document is corrected and the W-2 defect stands. (This also means the earlier "~755 px empty" figure was
wrong, not the usability conclusion.)

**Verification**

- Dark and light captured through CDP against the isolated acceptance build (identifier
  `com.neelima.cp10acceptance`, temp WebView2 profile; the shipping profile was never opened). Geometry identical
  in both themes and identical to the 3Q-1 baseline: sidebar 72 × 702, main panel 1027 × 650 at (84, 40), tree
  720 × 591, preview modal 920 × 207.
- `.tmp/3q2a/`: `dark-01..05`, `dark-04b-editor-dirty`, `light-01..05`, `light-04b-editor-dirty`, both
  `*-report.json`, `shots.js`, `launch.ps1`, `build.log`, `build2.log`, suite logs.
- Tests: UI 179/179 (was 165; +13 primitive/theme-compat/stylesheet-contract tests, including one that fails if a
  light `.btn-no` literal returns to the dark override or if that override grows layout properties), adapters
  80/80, Rust 348/348.
- Rust note: the first full run failed once on
  `skills::tests::local_install_update_preserves_edits_and_recovers_failed_staging` (assertion at
  `skills.rs:1129`). It passed 3/3 in isolation with `--lib`, and a full rerun was green at 348/348 with no error.
  Recorded as an intermittent, ordering-sensitive test, not a 3Q-2a regression — no Rust code changed in this
  checkpoint.
- `tsc --noEmit`, production `vite build` and `tauri build --debug` all succeeded as part of the acceptance
  rebuild (`build2.log`). The rebuild was required because the running binary embeds `ui/dist`.

**Not done (intentionally):** docked editor/preview pane, row selection, context menu, keyboard contract, terminal
dock, chat/diff/Automations/settings work, accessibility pass — all in 3Q-2b/3Q-3/3Q-4. `.btn-ok` shares the
double-declaration problem and is left for 3Q-3.

### 2026-11-08 — 3Q-2a review follow-up (three findings)

**1. `Tabs` missing from the delivered inventory; `SplitPane` too.** Correct: §10 listed both for 3Q-2a. Resolved by
auditing first, then implementing only what has a consumer.

- No reusable tab component existed — the strip was a local `EditorTabs` function inside `FileTree.tsx`. It now
  renders through a new `Tabs` primitive (`ui/src/components/ui/Tabs.tsx` + `tabBarClass`/`tabClass` in
  `uiPrimitives.ts`). This is a pure extraction: identical elements, classes, ARIA, title, dirty dot, close-button
  aria-label and Enter/Space handling (arrow-key navigation stays a 3Q-4 item). Verified by 6 jsdom interaction
  tests and by a rebuilt binary whose dark and light screenshots are byte-identical to the pre-extraction ones
  (`dark-04-editor.png` 62,261 B, `dark-05-diff.png` 66,410 B, `light-04-editor.png` 100,467 B before and after);
  `.editor-tabs` measures 918 × 33 with a 78 × 32 tab in both themes.
- No resizer exists anywhere in `ui/src` (`resizer`, `split-pane`, `SplitPane`, `drag-handle`: zero matches);
  `TerminalPanel` only reacts to container/browser resizes and the explorer width is fixed. `SplitPane` therefore
  has no 3Q-2a consumer and is **moved to 3Q-2b**, where the docked workspace gives it something to resize. §6 and
  §10 of the audit are amended; no placeholder component was created.

**2. Test-count arithmetic corrected.** 165 → 179 is **+14** (`uiPrimitives.test.js` holds 14 tests), not +13. The
follow-up adds +1 pure tab-class test and +6 jsdom `Tabs` tests, so the suite is now **186/186**. The "+13" in the
previous entry is superseded.

**3. Rust failure recorded as evidence, cause withdrawn.** Preserved: the first full run exited 101 with
`skills::tests::local_install_update_preserves_edits_and_recovers_failed_staging` failing
(`test result: FAILED. 282 passed; 1 failed`, `.tmp/3q2a/test-rust.log`); the same test passed 3/3 alone; a full
rerun passed 348/348 (`.tmp/3q2a/test-rust-2.log`). Calling it "ordering-sensitive" was an inference, not a
demonstrated root cause — withdrawn. No Rust code was changed.

Regression after the follow-up: UI 186/186, `tsc --noEmit` + production `vite build` OK (`build3.log`),
`tauri build --debug` OK (`build4.log`), dark/light captures identical in geometry and byte-identical to the
pre-follow-up PNGs. Adapters 80/80 and Rust 348/348 stand from the earlier run; no Rust or adapter code changed in
this follow-up. Acceptance instance closed again (0 `neelima` processes).
---

## Phase 3Q-2b — Interactive File Workspace (2026-11-08)

Implemented the amended 3Q-1 workspace milestone: the modal file-preview workflow is
replaced by a selection-driven workspace (docked explorer, resizable split, inline
preview in the editor pane, tabs that keep their drafts). No rename/delete/create,
no reveal, no drag-and-drop, no watchers, no terminal work, no new dependencies.

### Behaviour

- **Single click** selects the row and previews the file inline (never a modal); the
  selection highlight stays visible while the preview is shown.
- **Double click / Enter** open the file in an editor tab; reopening an already-open
  file activates its tab instead of adding a second one.
- **Space** toggles the inline preview of the selected file without opening a tab.
- **Arrows** keep CP5 tree semantics (Right expands or enters, Left collapses or
  returns to the parent); **Shift+F10 / right-click** open the file menu.
- The context menu offers only what the backend supports: Open in editor, Preview,
  Copy relative path, Copy absolute path, Share with chat. No placeholder actions.
- Opening/previewing another file never discards a dirty draft; every tab stays
  mounted, so drafts, cursors and scroll positions survive. Closing a dirty tab keeps
  the existing in-app confirmation.
- Sharing an **unopened** file reads disk at share time and is labelled
  `on-disk file at share time`; sharing an **open** document shares its current draft.
- The explorer/editor boundary is a real `role="separator"` (name, value, min, max,
  focusable, arrow keys/Home/End, double-click resets) and its width is persisted in
  settings (`explorer_width`, default 272) and restored on the next session.
- Preview reads are debounced 120 ms, cached per workspace+path for the session, and
  invalidated on save, verified agent write, manual refresh and workspace switch.
  Responses for a superseded selection or a previous workspace are discarded.

### Defects found and fixed while building this

1. **Preview stranded on "Loading preview…"** — opening a document tags the workspace,
   which runs `invalidateAll()`; a preview selected in that same tick had its debounce
   cancelled and no read reissued. `invalidateAll` now restarts a still-pending
   selection (a workspace switch clears `wanted` first, so no old read is revived).
   Regression: `previewCache.test.js` → "a selection pending during
   invalidateAll is restarted, never stranded loading".
2. **Clicking an open file could revert a just-typed draft** — activation passed the
   `editorDocs` array captured at render time, so a click that arrived before the
   deferred render wrote the older drafts back. All activations now re-read the store
   (`activateOpenDoc`). Covered by the mounted test that types, opens a second file and
   asserts the dirty draft survives.
3. **Preview header stacked its buttons vertically** (found in the native pass) —
   `.file-preview-head > div` set `flex-direction: column` and outranked
   `.file-preview-actions`, pushing Open / Share / Copy / close into a tall column.
   Fixed with `> div:not(.file-preview-actions)`; guarded by
   `uiPrimitives.test.js` → "the preview header keeps its action row horizontal".

### Tests

New: `ui/tests/previewCache.test.js` (13), `ui/tests/splitPane.test.js` (9),
`ui/tests/fileMenu.test.js` (6), 8 mounted cases in `ui/tests/fileTree-jsdom.test.js`
plus 1 in `uiPrimitives.test.js`. UI suite 186 → **224/224**. Rust **350/350**
(285 lib + 65 integration, includes the two new `explorer_width` settings tests),
adapters **80/80**, `tsc --noEmit` OK, production `vite build` OK, `tauri build
--debug` OK.

### Native acceptance (isolated)

Acceptance build with `.tmp/cp10-gui/tauri.acceptance.conf.json`
(`com.neelima.cp10acceptance`), isolated WebView2 profile and disposable workspaces
under `%TEMP%`: single-click preview with `modal:false`, `aria-selected:true`, 0 tabs;
context menu with exactly five supported actions via Shift+F10; double-click → 1 tab;
dirty tab (`app.ts●`) coexisting with a preview of `README.md`; splitter restored at
332 px, ArrowRight → 348; dark and light captures. Evidence:
`.tmp/3q2b/` (`evidence.md`, 7 PNGs, driver + logs).

Workspace lifecycle: both fixtures created under
`%TEMP%\neelima-3q2b-2026-11-08T15-45-37-249Z` (`insideRepo: []`), all four fixture
SHA-256 values unchanged after the run (no accidental writes), base directory deleted
(`stillExist: []`), acceptance settings restored byte-for-byte
(`a7a20019…` → `a7a20019…`, `matchesBackup:true`). `%APPDATA%\com.neelima.app` was
never written (current SHA-256 `81E709E7…C006D`). No `neelima` process remained.

### Limitations

- Workspace switching is not reachable from the Files surface, so the cross-workspace
  reset was verified in mounted tests, not natively.
- Terminal docking/resizing was explicitly out of scope for this checkpoint.
- The 400-entry explorer cap, large-write refusal and the absence of terminal session
  persistence remain as recorded in the Phase 3P register.

### Git

Branch `fix/vite-security`, HEAD `320a322`, no commit, no push, no reset/clean/stash,
`.tmp/` evidence preserved. Note: the index holds 1,926 staged entries (`.tmp` evidence
added by an earlier session); this checkpoint neither staged nor altered them.
