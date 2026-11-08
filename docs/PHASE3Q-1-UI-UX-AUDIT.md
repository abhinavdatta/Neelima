# PHASE 3Q-1 — Complete Application-Wide UI/UX Audit

Neelima · local-first desktop AI coding agent (Tauri v2 · Rust · Preact · TypeScript)

- Date: 2026-11-04
- Branch: `fix/vite-security` · HEAD `320a322` (unchanged during the audit; no commits, no source modifications)
- Working tree at audit end: same 67 pre-existing modified files plus the new audit artifacts only
  (`docs/PHASE3Q-1-UI-UX-AUDIT.md`, `docs/screenshots/3q1-*.png`, disposable `.tmp/p3q1-*` drivers, project log entry).
- Audit type: **inspection only** — no UI, styling, or backend changes were made.

---

## 1. Method and evidence

GUI inspection was performed against the real running debug build (`target/debug/neelima.exe`, WebView2, CDP port 9230).
Walkthrough automation asserted the visible state before every capture (selector + text assertions logged per shot), so each
screenshot below provably shows what its name claims.

Live captures (all real CDP screenshots of the running app, in `docs/screenshots/`):

Canonical (asserted) series:

| File | State shown |
|---|---|
| `3q1-01b-home-welcome.png` | Home welcome + composer (asserted: no modal, welcome heading present, composer present) |
| `3q1-02b-mode-menu.png` | Composer permission-mode menu open (3 items) — also shows rail popover overlay issue |
| `3q1-03b-provider-menu.png` | Composer provider menu (web adapters, local models, fallback) |
| `3q1-04b-skills-panel.png` | Task-skills picker expanded under the composer |
| `3q1-05b-files-view.png` | Files view, workspace tree |
| `3q1-05c-files-view.png` | Files view on disposable workspace (8 real rows asserted) |
| `3q1-06c-file-preview.png` | File preview modal open (`calculator.py`) |
| `3q1-07c-file-editing.png` | Editing state (textarea editor, footer status line asserted) |
| `3q1-08d-diff-modal.png` | Diff modal open with real draft delta (asserted: title, path, actions; cancelled afterward — nothing written) |
| `3q1-09b-terminal.png` | Terminal drawer open (xterm mounted) |
| `3q1-10b-provider-pane.png` | Provider sign-in pane (ChatGPT profile card) |
| `3q1-11b-automations.png` · `3q1-12b-marketplace.png` · `3q1-12c-marketplace-create.png` | Automations, Marketplace skills + adapter tabs |
| `3q1-13b-search.png` · `3q1-41-search-empty-state.png` | Search list and the true empty state ("No tasks matched … / Clear search") |
| `3q1-14b-settings-appearance.png` · `3q1-15-settings-providers.png` · `3q1-16-settings-models.png` · `3q1-17-settings-skills.png` · `3q1-18-settings-safety.png` · `3q1-19-settings-about.png` · `3q1-40-settings-appearance-tab.png` | All six Settings tabs |
| `3q1-20b-history-panel.png` | Projects/Recent tasks/Checkpoints rail panel |
| `3q1-21b-task-item-menu.png` | Task rename/delete popover |
| `3q1-30-chat-history-task.png` · `3q1-31-chat-tool-card.png` | Chat transcript from history, tool card expanded (verified-write output visible) |
| `3q1-42-light-theme-dom-override.png` | Light theme — **DOM attribute override of the app's own theme system, reverted immediately; not a saved setting** (labeled clearly because it is a render of the real stylesheet, not a persisted configuration) |

Superseded preliminary series (`3q1-01 … 3q1-22`, kept for the record): the first unasserted walkthrough run produced
duplicate frames and two mislabeled states; every one of those states was re-captured in the asserted series. The asserted
files above are the audit evidence; the preliminary ones are not relied upon for any finding.

Source inspection covered all 16 components under `ui/src/components/`, `App.tsx`, `store.ts`, `tauri.ts`, `fileEdit.ts`,
`theme.ts`, `approvalLifecycle.ts`, `types.ts`, and `styles.css` (1,311 lines), plus the relevant Rust command surface in
`src-tauri/src/ui.rs` (workspace/file commands) and `lib.rs` (window setup). The Phase 3O/Phase 3P state comes from
`WORK-LOG-2026-10-19.md` and `PHASE3-LIVE-BRIDGE-LOG.md` (Phase 3P checkpoint 1 to date; CodeMirror document-editor
integration had not yet landed when this audit ran — the coding workspace still uses the preview/textarea flow).

Contrast sampling (computed styles in the running app): theme tokens `--theme-bg #17191f`, `--theme-surface #242730`,
`--theme-raised #2d303a`, `--theme-text #eceef4`, `--theme-muted #a2a8b6`, `--theme-border #3b3f4b`, `--theme-accent #5966d8`;
muted text `rgb(162,168,182)` on main background `rgb(23,25,31)` = **7.37:1** (WCAG AA pass, AAA for large text).

Limitations: toast styling could not be captured in any walk (toasts auto-dismiss in 6 s; the triggered probe did not
surface one during its window) — toasts are assessed from source only. Streaming states need a live task and were not
exercised here (no provider task was started during the audit); they are assessed from source and prior live phases.
Light theme was inspected via the labeled DOM override; a true light-theme settings commit was not made (that would
change persisted user settings). Windows default browser dialogs (`window.confirm`) cannot be captured by CDP.

---

## 2. Design identity assessment (Material Glass + Soft Aero)

**What succeeds.** The core surfaces already express the direction: a soft lavender gradient backdrop under a blurred
glass shell, translucent left rail, soft 10–30 px shadows, 12–16 px radii, restrained indigo accent, and a genuinely
cohesive dark token set (`--theme-*`) that keeps text contrast strong (7.37:1 muted). The welcome hero, provider pane,
search pane, and settings modal read as one family. The composer is one unified glass block (meta row + input row +
chips), which matches the intended identity well.

**Where it fails.** The stylesheet is two design generations layered on top of each other. The file still opens with
`/* Neelima — ZCode-style dark UI */` and ~440 lines of hardcoded dark hex colors, then re-declares `:root` and later
sections with `var(--theme-*)` tokens. The same selectors are styled twice (`rail-button:focus-visible` exists verbatim
twice at lines 498–500; `.modal-head` is styled light `rgba(255,255,255,.96)` in the legacy block and dark in the live
cascade). Components that must re-style themselves for both themes hardcode colors (the marketplace warning banner uses
light-mode yellows inside the dark theme; the light theme keeps a near-black Search button; several buttons inherit no
chrome at all and read as plain text). The result is visually decent today but structurally fragile: any theme or
component change risks a cascade fight, and tokens exist but are not consistently consumed.

**Structural inventory of the system actually in use** (from the live app):
tokens: `--theme-bg/surface/raised/text/muted/border/accent` (7) + content gutter; spacing: ad-hoc (no scale);
typography: system UI + Cascadia Mono; glass: one 24 px blur on the shell, 12 px on modal sticky stripes, 4 px on
preview backdrops; radii: 7/9/12/16 px family; shadows: two hardcoded levels; buttons: five competing styles
(`btn-ok`, `btn-no`, `ghost`, `ghost danger`, `link`) where ghost buttons frequently render as bare text.

---

## 3. Screen-by-screen problem inventory

Severity: **Critical / High / Medium / Low.** Category letters: V visual, U usability, F functional, A accessibility,
C consistency, P performance concern, M missing functionality. Checkpoints refer to the Phase 3Q roadmap in section 6.

### A. Main application shell

| ID | Screen/component | Current condition | Problems | Severity | Recommended improvement | CP |
|---|---|---|---|---|---|---|
| A-1 | Rail popovers (Projects & recent tasks / Workspace tools) | `3q1-02b`, `3q1-30`, `3q1-31` | 272 px popover overlays the content column without a scrim; beginnings of chat messages and search rows continue underneath and are hidden; welcome headline is covered | High | Dock the popover (push the main column, as the file tree does) or add a scrim + refocus behavior | 3Q-3 |
| A-2 | Titlebar context label | `3q1-30` | In an opened task's chat the center label shows the workspace basename, not the open task's title; the "Past task · read only" label defined for `view==='task'` is unreachable in practice (opening a task sets `view:'chat'` with continuation) | Medium | Show the open task title and continue/readonly state in the titlebar | 3Q-3 |
| A-3 | Window-move strip | All screens | A persistent "Move window" strip sits top-center at all times even on the desktop app where window buttons already exist | Low | Render the strip only when native drag region is unavailable | 3Q-3 |
| A-4 | Global shortcut Ctrl+N | `App.tsx` | Hard-coded reset-task shortcut with no visible affordance or settings entry | Low | Document shortcuts in one place; make Ctrl+N status visible in the composer meta | 3Q-8 |
| A-5 | Window sizing | `lib.rs:186` | Default 1280×800, min 900×560 — reasonable | — | None | — |
| A-6 | Settings modal reopen | `3q1-14b` vs `3q1-40` | Reopening Settings restored the About tab in one run and Appearance in another (component stays mounted; `activeTab` survives `return null`) — non-deterministic | Medium | Always reopen on a defined tab (Appearance) or persist the last tab deliberately in config | 3Q-6 |
| A-7 | Rail buttons | All screens | Icon-only navigation; the current view is highlighted subtly; labels exist only as tooltips | Low | Keep icon rail, add a visible name for the active item and longer dwell tooltips | 3Q-3 |

### B. Native chat interface

| ID | Screen/component | Current condition | Problems | Severity | Recommended improvement | CP |
|---|---|---|---|---|---|---|
| B-1 | Assistant messages | `3q1-30/31`, `Chat.tsx Entry` | Reply text renders as a single plain `<div>`: no markdown, no code blocks, no lists, no tables — provider code replies appear as raw paragraphs; inline backticks show as literal characters | High | Add a small markdown renderer (remark/lightweight, lazy) with untrusted-content passthrough rules | 3Q-4 |
| B-2 | Assistant messages | `Chat.tsx` | No copy control anywhere on message blocks; copying a long reply requires manual selection | Medium | Per-message copy button (and per-code-block copy when B-1 lands) | 3Q-4 |
| B-3 | Tool-call cards | `3q1-31` | Args/out JSON truncated to 400/4000 chars with no ellipsis, no expand, no wrap fencing; the truncation is invisible to the user | Medium | Truncate with an explicit "show more" expander; keep verification line prominent | 3Q-4 |
| B-4 | Execution-check verdicts | `3q1-30` | The Phase 3O integrity verdict (the app's headline trust signal) renders as ordinary muted `sys-row` text, indistinguishable from system chatter | High | Dedicated verdict card (status color, code-styled path list, linking to the diff) | 3Q-4 |
| B-5 | Message copy/rhythm | `3q1-30` | System rows, bubbles and blocks use one 14 px gap; long terminal-ish replies have no max read width | Low | Set a comfortable max-width for message blocks and slightly larger rhythm between groups | 3Q-4 |
| B-6 | Error rows | `Chat.tsx error` | Error text-only rows with a 14 px icon; no retry affordance or task link | Low | Error card variant with task context and copy-friendly text | 3Q-4 |
| B-7 | Stream preview | `Chat.tsx StreamPreview` | Live tail only (last 2,400 chars) in a plain `<pre>` — honest and cheap, but the "chars" counter is jargon | Low | Label as "showing live tail" in user language | 3Q-4 |

### C. Chat composer

| ID | Screen/component | Current condition | Problems | Severity | Recommended improvement | CP |
|---|---|---|---|---|---|---|
| C-1 | Composer surface | `3q1-01b` | Unified glass block with meta row, input row, chips — succeeds | — | Preserve | — |
| C-2 | Menus (mode/provider) | `3q1-02b/03b` | The two composer menus have no Escape and no outside-click close; only re-clicking the anchor closes them; no focus trap or arrow-key handling | Medium | Implement a shared popover: Escape/outside/pick closes, arrow keys navigate | 3Q-4/3Q-7 |
| C-3 | Native confirm dialogs | `Composer.send`, `SettingsModal`, `Sidebar`, `FileTree` | Sending skills/attachments to web providers, discarding settings, task deletion, checkpoint restore and full-access switch all use `window.confirm` — a native dialog that cannot be styled, autocompleted, or keyboard-consistent with the app | High | Replace with one in-app confirm dialog component (danger-styled) across all five call sites | 3Q-7 |
| C-4 | Composer overflow | `3q1-04b` | Skills panel/context picker expand below the fold at 1280×800 without any internal scroll; content clipped by window edge | Medium | Give the composer box a bounded max-height with internal scrolling, or auto-collapse panels | 3Q-4 |
| C-5 | Keyboard interaction | `Composer` | Enter sends, Shift+Enter newlines; no visible hint; attachments list is fine; no mic button (per constraint) | Low | Add a subtle Enter/Shift+Enter hint in the meta row | 3Q-4 |
| C-6 | Attachment rows | `3q1-01b` (‑list from source) | Rows show name+status+Remove; statuses are wordy — fine but no progress affordance for extraction | Low | Compact status chips | 3Q-7 |

### D. Agent activity and approval interface

| ID | Screen/component | Current condition | Problems | Severity | Recommended improvement | CP |
|---|---|---|---|---|---|---|
| D-1 | Approval card | `Chat.tsx ApprovalCard` | Truncated JSON args (300 chars), no path highlighting, no language; risk chip colors exist but are small; per-item approve/reject → global submit is safe but the flow's three-step shape is not visually explained | Medium | Show args as path/action summaries with the JSON in an expander; add a one-line "why the extra submit" explainer | 3Q-4 |
| D-2 | Tool cards status | `3q1-31` | Status dot + status word present; good | — | Preserve; align dot colors with the new token set | 3Q-2 |
| D-3 | Bridge approval card | `Chat.tsx` | Browser-extension approval shares the agent approval visuals; correct isolation per lifecycle tests | Low | Add a distinct site-origin header so the two lifecycles are visually separated too | 3Q-4 |
| D-4 | Task progress | `3q1-30` | No visible task progress surface beyond status chips and waiting card's elapsed timer; command output only streams inside tool cards | Medium | Execution/test panel (see E-8) will own this; chat keeps summaries | 3Q-5 |
| D-5 | Stop / Emergency stop | topbar + global hotkey | Present, red, preserved | — | Keep (constraint) | — |

### E. Coding workspace (actual Phase 3P state: explorer + preview/edit + diff gate + terminal)

| ID | Screen/component | Current condition | Problems | Severity | Recommended improvement | CP |
|---|---|---|---|---|---|---|
| E-1 | Editor | `3q1-07c` | Plain `<textarea>`: no syntax highlighting, no line numbers, no wrap option, no find — CodeMirror document editor is the Phase 3P CP2+ plan item recorded in the project log, not yet built when this audit ran | — | Approved plan item; styling must follow 3Q-2 tokens | 3Q-5 |
| E-2 | Preview/edit actions | `3q1-07c` | "Cancel edit" renders as a white pill while "Review & save" renders as bare text — the destructive action has chrome, the primary action has none; inverted affordance | High | Style the diff-gated primary (btn-yes class) distinctly; ensure all action rows have visible buttons | 3Q-2/3Q-5 |
| E-3 | Diff modal | `3q1-08d` | CodeMirror MergeView with no pane labels — users must guess which side is disk vs proposed; no line numbers (currently), no syntax highlight | High | Add "On disk"/"Proposed" pane captions; keep the merge behavior and gate byte-for-byte | 3Q-5 |
| E-4 | Diff modal actions | `3q1-08d` | "Apply change" is text-like while "Cancel" is chromed — primary/destructive inversion again; Apply is the only path to `ui_file_save` and must read as the deliberate primary | High | Same fix as E-2; Apply inherits the in-app confirm styling from C-3 when adopted | 3Q-2/3Q-5 |
| E-5 | File tree | `3q1-05c` | No file-type icons; selected file highlight exists; expansion lazy | Medium | Add a small icon set for dir/code/doc/media; keep lazy loading | 3Q-5 |
| E-6 | File search | Missing | No filter/search input in the tree (spec'd by the user and in the current FileTree implementation absent) | Medium | Workspace-relative filter box in `ft-head` | 3Q-5 |
| E-7 | Agent-refresh | `FileTree` | Tree refreshes only manually; agent-created files appear after manual refresh or view reopen | Medium | One-shot event-driven refresh after approved writes (`transcript`/approval events), no polling | 3Q-5 |
| E-8 | Execution/test panel | Missing | Command output lives inside tool cards only; no execution-history/test output surface in the workspace | Medium | Render existing `command-output`/task events in a workspace bottom panel; no new execution system | 3Q-5 |
| E-9 | Terminal drawer | `3q1-09b` | Drawer opens with the full-height console; at capture there was no visible prompt yet (PTY connected async); close/title fine | Low | Show a connecting state until first output | 3Q-5 |
| E-10 | Workspace scoping | `FileTree`/`DiffModal` | Tree is workspace-scoped and reset on workspace change (verified in source + live in Phase 3P); good | — | Preserve | — |

### F. Settings

| ID | Screen/component | Current condition | Problems | Severity | Recommended improvement | CP |
|---|---|---|---|---|---|---|
| F-1 | Settings nav | `3q1-14b…19` | Six tabs with icons, arrow-key navigation implemented — a genuine strength | — | Preserve | — |
| F-2 | Grouping | `3q1-16` | "Project context" lives inside the "Local models" tab; it applies to web providers too | Medium | Promote context to its own section (or General) when tabs are re-laid | 3Q-6 |
| F-3 | Local models form | `3q1-16` | "Reply timeout (s)" label wraps away from its input into a second line (orphan labels/inputs across the tab; number rows read as three unexplained fields) | Medium | Grid-based settings rows: fixed label column, aligned input column | 3Q-6 |
| F-4 | Danger actions | `3q1-15` | "Remove" and "Clear sign-in data" render identical to neutral "Sign in" ghost text — no red styles, no group separation; irreversible actions look reversible | High | Give danger actions the red treatment + (with C-3) the in-app confirm | 3Q-2/3Q-6 |
| F-5 | Test buttons | `3q1-16` | Local model "Test" disables silently until the draft URL equals the saved URL; the constraint lives only in a tooltip | Low | Inline note when the test is pending-draft-change | 3Q-6 |
| F-6 | Dirty flow | `3q1-40` | Footer shows "All changes saved"/"Unsaved changes" + Cancel + Save; discard uses `window.confirm` (C-3) | Medium | Adopt shared confirm; keep the footer indicator | 3Q-6 |
| F-7 | Appearance tab | `3q1-40` | Five theme cards with previews; custom theme gets a code editor with validation/errors — good | — | Preserve; add hints that previews are indicio of actual palette | 3Q-6 |

### G. Dialogs and secondary interfaces

| ID | Screen/component | Current condition | Problems | Severity | Recommended improvement | CP |
|---|---|---|---|---|---|---|
| G-1 | Alert systems | Global | Three coexisting alert languages: app modals, native `window.confirm` at 5+ call sites, and toasts | High (consistency) | One confirm component + toasts; remove all native confirms | 3Q-7 |
| G-2 | Menus/popovers | `3q1-21b`, C-2 | `.menu` popovers and rail popovers close only via toggle/own close buttons; each has a bespoke implementation | Medium | Shared popover primitive (web/mode/measure menus, task/folder menus) | 3Q-7 |
| G-3 | Toasts | Source only (`styles.css` 436–; capture limitation) | Fixed bottom-right stack, 6 s auto-dismiss; styling was not visually verified this run | Low | Verify visually in 3Q-7; align with glass tokens | 3Q-7 |
| G-4 | Empty states | `3q1-41` | Search empty state is exemplary; task checklists similar | — | Reuse this pattern for files tree (no workspace) and marketplace | 3Q-7 |
| G-5 | Loading states | `3q1-09b`, `FileTree` | "Opening…" text exists in file rows; terminal has no connecting state; context scan has its own scanning note | Low | Shared spinner/skeleton treatment | 3Q-7 |

### H. Interaction behavior (app-wide)

| ID | Component | Current condition | Problems | Severity | Recommended improvement | CP |
|---|---|---|---|---|---|---|
| H-1 | Focus visibility | `styles.css` | `:focus-visible` outlines exist for rail buttons, file rows and settings/modal buttons; other controls rely on browser defaults with differing colors | Medium | One outline token + consistent `:focus-visible` on every interactive element | 3Q-8/3Q-9 |
| H-2 | Reduced motion | `styles.css` | No `prefers-reduced-motion` handling anywhere; smooth scrollIntoView on every transcript event | Medium | Add the media query; make animation/scroll durations tokenized and reduced-motion aware | 3Q-8 |
| H-3 | Hover/pressed states | `styles.css` | Present for buttons/menus, hardcoded colors in the legacy block | Low-mid | Fold into the token set (3Q-2) with shared hover/active mixins | 3Q-8 |
| H-4 | Keyboard traps | Source | Modals close on Escape (Settings, file preview) but focus is not trapped nor restored to the trigger | Medium | Focus trap + restore for modal dialogs | 3Q-9 |
| H-5 | Menu keyboards | C-2 | Menus ignore arrow keys | Medium | Shared popover primitive covers this | 3Q-7 |
| H-6 | Panel resizing | `3q1-05c`, `styles.css 16–18` | File tree fixed 272 px with collapse toggle; no resizable splitters on the drawer/tree | Low | Optional drag handle for the terminal drawer height in 3Q-5 | 3Q-8 |

---

## 4. Most important problems (detailed)

1. **Assistant replies are not markdown-rendered (B-1, High).** Neelima's entire value is reading AI replies about
   code. Today a reply like "edit `calculator.py`, then run `python test_calculator.py`" renders as a wall of plain
   text with literal backtick characters, no code blocks, and no way to copy code without selecting text. Evidence:
   `3q1-30/31`; `Chat.tsx` renders `e.text` in a bare div. This is the single highest-leverage usability gap.
2. **Integrity verdicts lack visual authority (B-4, High).** The Phase 3O achievement — truthful on-disk verification
   ("verified against recorded file operations…") – renders as 13 px muted gray system chatter inside the transcript
   (screenshot 3q1-30). The trust signal every approval decision depends on is the visually weakest element on screen.
3. **Primary/destructive button affordances are inverted in the file flow (E-2/E-4, High).** In the editor modal the
   destructive "Cancel" is a chromed pill while the primary "Review & save"/"Apply change" is text; in the settings
   providers tab, irreversible "Remove"/"Clear sign-in data" carry no danger styling at all (3q1-15). Users learn that
   real actions look like labels — an anti-pattern that increases accidental-action risk.
4. **Rail popovers hide content instead of moving it (A-1, High).** The 272 px popover overlays the main column with no
   scrim; the beginning of assistant messages, the welcome headline, and search rows hide underneath and are effectively
   unreadable while the panel is open (02b/03b/30/31). The file tree already shows the right model: dock and push.
5. **Three alert systems (G-1, High).** Native `window.confirm` is used for full-access switching, provider removal,
   session clearing, task deletion, checkpoint restore, skill install, and web-provider send disclosures. It cannot
   match the app's visual identity, is OS-positioned, and offers no danger-color semantics. One styled confirm
   component removes six inconsistencies at once.
6. **Composer menus have no ambient dismissal or keyboard navigation (C-2, Medium/H).** Escape, outside click and
   arrow keys do nothing; only re-clicking the anchor closes them. Every other surface in the app does better.
7. **Light theme ships half of the identity (C, Medium/H).** `42` proves the light stylesheet works
   (soft lavender field, white glass panels, readable text), but hardcoded legacy colors leak through: the Search
   button stays near-black, several chips don't flip. The 3Q-2 token conversion fixes the entire class.
8. **Forms in Settings mis-wrap (F-3, Medium).** "Reply timeout (s)" label orphaned from its number input (16);
   number fields read as unlabeled boxes. A fixed-label grid resolves the tab's whole layout at once.
9. **Editor/diff have no line numbers and no syntax highlighting (E-1/E-3, roadmap).** Known Phase 3P sequencing:
   the CodeMirror document editor and language packs were accepted in CP1 (dependency plan in the log) but not built
   before this audit. 3Q-5 restyles both on top of the approved 3P plan.
10. **Store-wide re-render cost (P, watch).** Every `setState` re-renders the entire app via `useStore`. At current
    component counts this is fine (idle CPU measured 0.0 ms), but a Markdown-rendered chat plus a multi-tab editor
    will change that ratio; 3Q-4/3Q-5 should split heavy subtrees or switch lists to keyed memo components.

---

## 5. Shared components to standardize (3Q-2 scope)

- `GlassSurface` wrapper (tokenized blur/radius/shadow levels) — today re-implemented ad hoc in shell, modals, popovers.
- `Button` variants (primary, neutral, danger, ghost, link) — replaces the five current pseudo-classes and fixes E-2/E-4/F-4.
- `ConfirmDialog` (in-app, danger-capable) — removes all `window.confirm` (C-3/G-1).
- `Popover`/`Menu` primitive anchored, Escape/outside/keyboard — replaces `.menu`, `.ti-menu-pop`, `.pi-menu-pop`, rail panels (C-2/G-2).
- `Toast` with token styling and an aria-live region.
- `EmptyState` (search/file tree/marketplace/tasks share one) — the search pattern is the template (G-4).
- `SectionHeader`/`FieldRow` for Settings forms (label column fixed) (F-3).
- `StatusChip`/`RiskBadge` for tool/risk/status coloring (already half-built via `.dot`/`.risk-*`).
- Focus-ring and scrollbar tokens shared app-wide (H-1).

## Components/behaviors to preserve without alteration

- The diff-gated save pipeline: textarea/preview → `DiffModal` → `ui_file_save` — the approval gate byte-for-byte (E-10).
- `@codemirror/merge` diff view behavior behind DiffModal.
- Terminal panel + Rust PTY (`ui_terminal_*`) and its disposal logic.
- Approval lifecycle rules (`approvalLifecycle.ts`), ledger and execution verification — untouched by any 3Q UI work.
- Provider pane structure and its sign-in states; `providerStatus` event handling.
- Settings tab keyboard navigation and modal Escape handling.
- Theme token architecture (`theme.ts` + `data-theme` application) and the custom-theme safety editor.
- Workspace confinement and all Rust-only filesystem command usage; no client filesystem access anywhere.

## Functional issues requiring separate investigation (not UI styling)

1. Settings modal reopen tab non-determinism (A-6) — need to confirm whether `activeTab` persists across mounts; consistent behavior must be decided before restyling.
2. Terminal drawer's first paint shows an empty console (E-9) — verify PTY banner timing; possibly a real cold-connect delay.
3. `ui_tree("")` on the real `inamigos webdev` workspace listed only the `task1` subfolder while the disposable workspace listed all files — could be a directory-entry cap or the workspace genuinely containing one folder; verify before assuming a bug.
4. Attachment extraction statuses observed in code paths (failed OCR, image-only notes) deserve one usability test on a real PDF to confirm the messaging (no OCR claim) matches user expectations.
5. The v1 capture anomaly (an unasserted first-run screenshot showing a leftover desktop state) was tooling-related (stale CDP target after an app restart), not an app defect; superseded evidence noted for the record.

---

## 6. Phase 3Q implementation roadmap (plan only — nothing implemented here)

Sequence notes: 3Q-2 comes first because every other checkpoint consumes the tokens, button and popover primitives from
it. 3Q-4 (chat) precedes 3Q-5 (workspace) because B-1 (markdown) changes the chat DOM that the panel and verdict cards
live in. A11y rides on 3Q-8 (motion/interaction) and 3Q-9 (keyboard/contrast/labels). Acceptance of 3Q-10 requires live
GUI inspection on all sizes again.

### 3Q-2 — Design system standardization
- Objectives: single `:root` token block (colors incl. light theme, spacing scale, radii, shadows, focus ring, typography, scrollbars); export `Button` (primary/neutral/danger/ghost/link), `GlassSurface`, `StatusChip`, `Popover`, `Toast`, `ConfirmDialog`, `EmptyState`, `FieldRow` primitives; remove duplicated legacy CSS blocks and all `window.confirm` call sites.
- Affected: `ui/styles.css` (restructure), new `ui/src/components/ui/*`, all components' classNames.
- Dependencies: none; must not change any handler logic or store behavior.
- Risks: cascade regressions across 1,311 CSS lines; theme switching correctness.
- Tests: unit tests for pure primitives (confirm flow, popover keyboard), existing suites full pass, UI production build, side-by-side theme screenshots dark + light.
- Acceptance: no `window.confirm` remains; no duplicated selector blocks for card/button/menu; button affordances correct per state (E-2/E-4/F-4 fixed); light and dark themes both fully token-driven.

### 3Q-3 — Shell and navigation
- Objectives: dock rail popovers (or scrim + push), titlebar context correctness (task title, view labels), move-strip cleanup, active-rail labeling.
- Affected: `Sidebar.tsx`, `TitleBar.tsx`, `App.tsx`, `styles.css` layout blocks.
- Risks: drag-region interference with the Tauri window controls.
- Tests: interaction tests for popover behavior; screenshot pass at 1280×800 and 900×560.
- Acceptance: no content hidden behind popovers; titlebar label always names the current context.

### 3Q-4 — Native chat redesign
- Objectives: markdown rendering with code blocks + copy controls; verdict card for execution checks; tool-card expanders; chat width/rhythm; popover primitives in composer menus; bounded composer panels.
- Affected: `Chat.tsx`, `Composer.tsx`, `styles.css`, new `ChatMarkdown` (lazy-loaded), possibly `types.ts` (none in Rust).
- Dependencies: 3Q-2 primitives; must not change agent/store event flow.
- Risks: performance on long transcripts (marking untrusted text; memoization).
- Tests: markdown sanitizer attack cases (untrusted passthrough), unit tests for truncation limiters; full suites; live chat screenshot with a real reply or history.
- Acceptance: code blocks render fenced with copy buttons; verdict card visually distinct and truthful; composer panels no longer clipped.

### 3Q-5 — Coding workspace refinement
- Objectives: complete the Phase 3P editor plan (CodeMirror editor + tabs + save flow + explorer icons/filter/refresh + diff pane labels + execution/test panels + terminal connecting state) with the 3Q-2 visual language.
- Affected: `FileTree.tsx`, new `NativeEditor.tsx`/tab store, `DiffModal.tsx`, `TerminalPanel.tsx`, new panels, `styles.css`.
- Dependencies: 3P CP-sequence remains authoritative (CP2–CP9 as logged); 3Q style pass rides on each.
- Risks: editor memory/lazy-load discipline (keep the Phase 3P performance envelope; measurement scripts must match).
- Tests: 3P checkpoint tests + the 14 acceptance tests listed in Phase 3P CP9; before/after performance table.
- Acceptance: all Phase 3P checkpoints complete with no measured regression; workspace visuals consistent with 3Q-2.

### 3Q-6 — Settings redesign
- Objectives: FieldRow grid; context section promotion; danger-action styling; reopen-tab decision implemented; draft-dirty affordances.
- Affected: `SettingsModal.tsx`, `SkillsPanel.tsx`, `styles.css`.
- Dependencies: 3Q-2 primitives + the 3Q-5-agnostic decision on A-6 behavior.
- Risks: settings schema unchanged (types untouched).
- Tests: unit tests for dirty/commit flow; manual per-tab screenshot pass.
- Acceptance: every setting readable at min window size; danger actions visibly dangerous; tab behavior deterministic.

### 3Q-7 — Dialogs, menus, secondary surfaces
- Objectives: shared popover/menu primitive everywhere; ConfirmDialog adoption completes; toasts Glassified; empty/loading/spinner treatment shared; tooltips consistent.
- Affected: all components with menus; `store.ts` (toast data only).
- Dependencies: 3Q-2.
- Risks: accessibility regressions in menu focus handling — test explicitly.
- Tests: keyboard-navigation unit tests; toast capture (issue G-3 limitation resolved); screenshot pass.
- Acceptance: one popover implementation; one confirm implementation; all empty states share the pattern.

### 3Q-8 — Interaction and animation refinement
- Objectives: tokenized durations/transitions; `prefers-reduced-motion` complete; hover/active tokens; optional drawer resize; scroll behaviors (chat autoscroll only when at bottom).
- Affected: `styles.css`, `Chat.tsx` scroll logic, `TerminalPanel.tsx` fit.
- Risks: low.
- Tests: reduced-motion emulation screenshots; interaction test for autoscroll pinning.
- Acceptance: motion reduced under the media query; no scroll jumping on new lines when scrolled up.

### 3Q-9 — Accessibility and desktop usability
- Objectives: focus traps + restore for modals; full `:focus-visible` coverage; aria labels audit (icon-only buttons); contrast re-verified in both themes; min-window layouts at 900×560 verified.
- Affected: modals, menus, icon buttons, `styles.css`.
- Tests: tab-order walkthrough scripts; contrast sampling (repeat of this checkpoint's method); screen reader smoke labels list.
- Acceptance: no unreachable control by keyboard; contrast AA in both themes; labels on every icon-only control.

### 3Q-10 — Visual regression and final acceptance
- Objectives: full-screen screenshot comparison suite (this audit's captures become the baseline), layout validation at 3 window sizes, final interaction verification, performance re-measure (idle CPU + tree memory same scripts as Phase 3P CP1), final report.
- Affected: new `.tmp/` regression driver + docs table.
- Acceptance: all suites pass; screenshots reviewed; no unresolved High severity from this audit's inventory.

---

## 7. Performance watchlist (no changes made this checkpoint)

- `useStore` full-app re-render on every event (H-6) — fine at my measured sizes (0.0 ms idle CPU across three states,
  Phase 3P CP1 baseline); will matter more once markdown + tabs land — memoize during 3Q-4/3Q-5.
- Three deliberate `backdrop-filter` layers (24 px shell, 12 px modal sticky stripes, 4 px preview backdrop) — modest
  but compositing-sensitive on window resize; keep the count low.
- Continuous listeners: one `setInterval` only inside `ProviderWaitCard` while waiting (1 s, bounded); xterm fit +
  ResizeObserver properly disposed (verified in source); context preview debounced 450 ms.
- No polling or workspace indexing exists — the Phase 3P "no continuous indexing" rule holds.
- Budget target: post-integration tree working set should stay in the 440–480 MiB band on the debug build with the same
  measurement scripts; large-file editor responsiveness will be re-measured in Phase 3P CP2/CP3 under identical scripts.

---

## 8. Deliverables map

1. This file — complete findings.
2. Section 3 — screen-by-screen inventory (45 classified entries A-1…H-6 incl. sub-issues).
3. Priority ranking — section 4 (top ten; all High findings first in each checkpoint).
4. Screenshot evidence — `docs/screenshots/3q1-*.png` (asserted series canonical).
5. Phase 3Q plan — section 6 (ten checkpoints with objectives/screens/risks/tests/acceptance).
6. Shared components to standardize — section 5 list.
7. Components to preserve — section 5 list.
8. Functional issues for separate investigation — section 5 list.

## 9. Confirmations

- No application source code was modified in this checkpoint.
- No dependencies installed; no backend behavior changed; no workspace's files were written (the diff modal was opened
  with a deliberately typed draft and explicitly cancelled; the file on disk was never touched).
- All existing uncommitted work preserved; `.tmp/` evidence retained; canonical project log preserved (appended only).
- Inspector app instance terminated after evidence collection; active workspace state unchanged.
