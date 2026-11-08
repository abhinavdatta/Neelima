# Phase 3Q-1 — Current UI Design Audit and 3Q-2 Redesign Specification

Neelima · local-first desktop coding agent (Tauri v2 · Rust · Preact · TypeScript)

- Date: 2026-11-08
- Branch `fix/vite-security` · HEAD `320a322` · 0 staged · 43 modified tracked files · 118 untracked entries
- Audit type: **analysis only**. No source file, stylesheet, component, dependency or setting was changed.
  The one application instance used for evidence ran on the separately identified acceptance build
  (`com.neelima.cp10acceptance`), never the shipping profile.

This document supersedes the *workspace-related* sections of `docs/PHASE3Q-1-UI-UX-AUDIT.md` (2026-11-04).
That audit is accurate for the shell, chat, composer, settings and dialogs, but it was written before Phase 3P
CP2–CP10 landed: it describes a textarea editor, no diff gate, no tabs and no execution history. Those surfaces
have since been rebuilt and are re-audited here from the live application. The 2026-11-04 document remains the
historical record and is not edited.

**Revision R1 — 2026-11-08 (user feedback).** The visual direction is approved; this revision changes the
emphasis, not the identity. The user's finding is that the Files surface does not communicate what can be done
with a file, so §7 was rewritten around a code-verified interaction audit instead of a layout sketch, §10 now
puts the file workflow first, and §12 lists the decisions that audit surfaced. This revision is analysis only:
no source, stylesheet, component or dependency was touched.

---

## 1. Method and evidence

**Live captures (current code).** The real debug build was rebuilt with the acceptance config, launched with a
dedicated WebView2 profile and a test-only CDP port, pointed at a disposable workspace under the OS temp root
(9 files, 2 nested directories), and driven through each surface. Every capture asserted its DOM state before
the screenshot; the assertions are stored in `.tmp/3q1-audit/walkthrough.json`.

| File | State asserted | Size |
| --- | --- | --- |
| `.tmp/3q1-audit/01-home.png` | `.welcome` present, heading text, composer present, no modal | 90 KB |
| `.tmp/3q1-audit/02-files-tree.png` | `.filetree` present, 7 rows, row names, header buttons | 37 KB |
| `.tmp/3q1-audit/03-file-preview.png` | `.file-preview` open, title/meta text, action buttons | 69 KB |
| `.tmp/3q1-audit/04-editor-tabs.png` | 1 `.editor-tab`, 1 `.cm-editor`, footer text, action classes | 65 KB |
| `.tmp/3q1-audit/05-terminal.png` | `.terminal-drawer`, 1 `.xterm` | 68 KB |
| `.tmp/3q1-audit/06-settings.png` | `.modal` open, six settings tabs, title | 89 KB |
| `.tmp/3q1-audit/07-automations-history.png` | `[data-testid="execution-history"]` present, empty-session text | 74 KB |

**Measured in the running app** (CDP `getBoundingClientRect` / `getComputedStyle`):
viewport 1123 × 702 CSS px at the default window size (captures are 1412 × 893 at 1.25 device pixel ratio);
rail 72 px; main panel 1027 px wide at x=84; terminal drawer 962 × 151 at (117, 534).

**Static inspection:** `ui/src/styles.css` (1,525 lines), all 21 components, `App.tsx`, `store.ts`, `theme.ts`,
`editorTabs.ts`, `editorHost.ts`, `executionHistory.ts`, `fileEdit.ts`, `editorContext.ts`, `tauri.ts`.

**Prior evidence retained:** `docs/screenshots/3q1-*.png` (2026-11-04, valid for shell/chat/settings/dialogs;
stale for the workspace), `.tmp/cp10-gui/` (Phase 3P acceptance).

**Limitations of this evidence:** CDP captures are pixel-accurate but no human visual review was performed;
toasts were not captured (6 s auto-dismiss, as in the 2026-11-04 audit); light theme was not re-captured;
streaming and running-task states were not exercised (no provider task was started); Windows only.

---

## 2. Current UI inventory (facts)

**Shell.** `#app` → `.sidebar` (72 px icon rail: logo, new project, provider, search, tools, history; settings at
the bottom) + `.window-shell` → `.titlebar` (assistant selector + context label + terminal/min/max/close) →
`.main-panel` (radius 24, inset from window edges) → `.content`. A `.window-move-strip` sits top-centre at all
times. Rail popovers (`.rail-popover`, 272 px) overlay the content without a scrim.

**Views** (`State.view`): `chat`, `task` (read-only history), `files`, `provider`, `automations`, `marketplace`,
`search`. Chat and task share `Chat` + `Composer`; `files` renders `FileTree` (which itself contains the editor
modal, the tab bar and the preview); `automations` renders live agent state, command output, `ExecutionHistory`
and checkpoint controls; `settingsOpen` overlays `SettingsModal` with six tabs.

**Chat.** User bubbles, assistant text as one plain `<div>`, `<details>` tool cards (status dot, tool, id, risk
chip, status label, duration, exit, action id, args JSON sliced to 400 chars, output sliced to 4,000),
approval card (per-item Approve/Reject then a global Submit), bridge-approval card, provider-wait card,
stream tail preview, relay card, system/done/error rows.

**Coding workspace.** Fixed 720 px explorer (header: share / refresh / collapse; honest `loading`, `empty`,
`error` + `Retry`, truncation notice; ARIA `tree` with roving focus), then a centred modal for the document:
preview (`<pre>`, 920 px max, paging for large files) or editor (CodeMirror 6, one instance per open document,
multi-tab bar with dirty dots, footer status `N lines · N bytes · saved|unsaved draft · saving writes after you
review the diff`), actions `Review & save` (`.btn-yes`), `Close all` (`.btn-no`), close icon. Saving opens
`DiffModal` (`@codemirror/merge`) which is the only path to `ui_file_save`.

**Terminal.** `.terminal-drawer` flex child of the content column, `clamp(150px, 28vh, 280px)`, xterm.js over the
Rust PTY, header with title, workspace name, status (`Live`/`Connecting`/error + retry), close.

**Execution history.** Inside Automations, rendered as `.card` blocks; rows are `<details>` with tool, call id,
path, status, duration, exit, and expanded args/output.

**Settings.** Modal, left nav (six tabs, arrow-key navigation), content max 700 px, footer with
saved/unsaved indicator, Cancel and Save.

---

## 3. Defects (each with evidence)

Severity: High = damages a core workflow or trust signal; Medium = visible quality/usability cost;
Low = polish. "Observed" means seen in the live capture or measured; "Source" means read in code.

### 3.1 Coding workspace (the redesign's centre of gravity)

| ID | Defect | Evidence | Severity |
| --- | --- | --- | --- |
| W-1 | **The primary action is unstyled.** `.btn-yes` is used twice in components and has **zero** CSS rules; `.btn-no` has 4. So `Review & save` / `Apply change` render as bare text while the secondary `Close all` / `Cancel` renders as a filled pill. The deliberate, diff-gated commit is the least button-like control on screen. | Observed `04-editor-tabs.png`, `03-file-preview.png`; Source `styles.css` (0 matches), `components/*.tsx` (2 uses) | High |
| W-2 | **The workspace wastes the desktop.** The explorer is a fixed 720 px column; the other ~307 px of the content area is empty. Opening a file covers that column with a centred modal instead of occupying the space. Measured: main panel 1027 px, tree 720 px, modal `min(920px, 92vw)`. | Observed `02`, `03`, `04`; measured | High |
| W-3 | **No file-type iconography, no filter, no breadcrumb.** The header holds only refresh and collapse. Directories and files differ only by font weight and colour. There is no workspace search box, no path context beyond indent, no new-file action. | Observed `02-files-tree.png`; Source `FileTree.tsx` `ft-head` | Medium-High |
| W-4 | **Developer copy in a user surface.** The preview header prints `115 bytes · workspace-relative path`; the editor header duplicates the path twice (`src/app.ts` then `app.ts · src`). | Observed `03`, `04` | Low-Medium |
| W-5 | **No line numbers, no find, no wrap control** in the editor (`lineNumbers: false` measured). CodeMirror is mounted with syntax highlighting only. | Observed `04`; measured | Medium |
| W-6 | **Action cluster has no reading order.** In the preview, `Edit` and the close `×` stack in two rows at the top right, separated from the document meta; in the editor, `Review & save` sits alone in the header while `Close all` sits in a pill below it. | Observed `03`, `04` | Medium |
| W-7 | **Diff has no pane identity.** `DiffModal` renders MergeView with no "On disk" / "Proposed" captions, so the two sides must be inferred. | Source `DiffModal.tsx`; prior capture `docs/screenshots/3q1-08d-diff-modal.png` | High |
| W-8 | **Terminal drawer is visually detached.** Full-width black band, square corners against a 24 px rounded shell, no drag handle, fixed `clamp()` height, and it consumes the content column rather than docking under the workspace. | Observed `05`, `07`; measured 962 × 151 | Medium |
| W-9 | **A single click opens a modal; there is no selection step.** Row click calls `toggle()`, which fetches `ui_file_preview` and covers the tree. `onDblClick`, `onContextMenu` and any selection-only path do not exist in the component. | Source `FileTree.tsx` `toggle()`/`onClick`; greps for `onDblClick`/`onContextMenu` = 0; observed `03-file-preview.png` | High |
| W-10 | **The only selected-row styling is invisible in practice.** `.ft-row-selected` is applied to the previewed file, but the preview modal covers it, so the tree never shows what is selected. | Source `FileTree.tsx:745`, `styles.css:310`; observed `02` vs `03` | High |
| W-11 | **No way to act on a file from the tree.** The header share control targets the active editor document, so "use this file in chat" requires opening the editor first and is undiscoverable from Files. | Source `FileTree.tsx:510` `shareEditorWithAgent()` | Medium-High |
| W-12 | **Rows have no action vocabulary.** No type icons, no context menu, no hover-affordance beyond a background tint, and folders/files differ only by weight — filenames read as static labels. | Observed `02-files-tree.png` | Medium-High |

### 3.2 Chat and approval

| ID | Defect | Evidence | Severity |
| --- | --- | --- | --- |
| C-1 | **Assistant replies are plain text.** No markdown, no code blocks, no lists; inline backticks appear literally; no copy control anywhere. For a coding agent this is the single largest usability gap. | Source `Chat.tsx` `<div class="msg-text">{e.text}</div>`; no markdown dependency in `ui/package.json` | High |
| C-2 | **Silent truncation.** Tool args are cut at 400 chars and output at 4,000 with no ellipsis and no expander, inside a `<details>` that already implies completeness. | Source `Chat.tsx` `slice(0, 400)` / `slice(0, 4000)` | Medium |
| C-3 | **Approval card is JSON-first.** Risk chip and tool name are present, but the destructive decision is argued from a 300-char JSON blob; the approve/reject-then-submit sequence is not explained in the UI beyond one dim line. | Source `Chat.tsx ApprovalCard`; prior capture `3q1-31` | Medium |
| C-4 | **Verdict/verification messages are indistinguishable from system chatter** (`sys-row`), although disk verification is the product's trust signal. Unchanged since 2026-11-04. | Source `Chat.tsx`; prior capture `3q1-30` | High |
| C-5 | **Three alert languages.** 14 `window.confirm` call sites across 6 components (Composer ×4, Settings ×3, Sidebar ×2, Marketplace ×2, SkillsPanel ×2, plus FileTree's documented target) coexist with app modals and toasts. | Source grep | High |

### 3.3 Shell and system

| ID | Defect | Evidence | Severity |
| --- | --- | --- | --- |
| S-1 | **No design-token discipline.** One `:root` block declares 8 colour tokens, but the stylesheet contains **699 literal hex colours** and **69 `rgba()` literals** against **127 `var(--…)` uses**; two `:root` blocks exist. Theme switching therefore only covers the parts that happened to be tokenised. | Measured on `styles.css` | High (root cause) |
| S-2 | **No scales.** 20 distinct `border-radius` values (2–28 px plus `50%`/`999px`), 19 distinct `font-size` values (9–38 px), 14 distinct `gap` values (1–14 px). Visual inconsistency is structural, not a matter of taste. | Measured | Medium |
| S-3 | **Nested surfaces.** The explorer is a card inside the main panel; Automations is four `.card` blocks inside the panel; Settings is a nav panel inside a modal inside a blurred backdrop. Three background levels are never justified by information hierarchy. | Observed `02`, `06`, `07`; Source `AutomationsPane.tsx` | Medium |
| S-4 | **Reduced motion is effectively absent.** One `prefers-reduced-motion` rule exists and it only disables the party-mode easter egg; the transcript still runs `scrollIntoView({behavior:"smooth"})` on every entry. | Source `styles.css:1361`, `Chat.tsx` | Medium |
| S-5 | **Rail has no labels**, only tooltips; the active state is a subtle tint. The "Move window" strip is always visible. | Observed `01`–`07`; Source `Sidebar.tsx`, `TitleBar.tsx` | Low |
| S-6 | **Titlebar context is wrong in chat.** It prints the workspace basename whenever `view === "chat"`, including while reading an opened task, where the task title is the useful context. | Source `TitleBar.tsx:22` | Medium |

### 3.4 Settings and secondary screens

| ID | Defect | Evidence | Severity |
| --- | --- | --- | --- |
| T-1 | Settings is structurally sound (nav + 700 px content + footer + arrow keys) and is the best surface in the app; the outstanding issues are form-row wrapping (orphan "Reply timeout (s)" label) and danger actions (`Remove`, `Clear sign-in data`) that look identical to neutral ghost text. | Source `SettingsModal.tsx`; prior captures `3q1-15/16` — **not re-verified today** | Medium |
| T-2 | Appearance preview cards are built from light-theme swatches inside a dark modal; "Light"/"System" read as bright rectangles that compete with the theme name. | Observed `06-settings.png` | Low-Medium |
| T-3 | Execution history rows carry status/duration/exit but no column headers and no filter; the section is a card nested in a card under an `h3` that duplicates the page heading style. | Observed `07`; Source `ExecutionHistory.tsx` | Medium |

### 3.5 Accessibility (source-verified)

| ID | Defect | Severity |
| --- | --- | --- |
| A-1 | Focus styles are per-selector; no single `:focus-visible` token, so colour and offset vary by control. | Medium |
| A-2 | Modals do not trap focus or restore it to the trigger (Settings and preview close on Escape only). | Medium |
| A-3 | Popovers (composer menus, rail panels, task/folder menus) close only by re-clicking their anchor; no Escape, no outside click, no arrow-key navigation (four implementations). | Medium |
| A-4 | Icon-only buttons are mostly labelled (good), but the new editor tab close and tree "share" controls rely on `title` alone in places. | Low |
| A-5 | Toasts have no `aria-live` region. | Medium |
| A-6 | The file tree is genuinely well done (roving focus, `role="tree"`, `aria-busy`, alerts, honest states) and is the model the rest of the app should follow. | — |

---

## 4. Design direction (decisions to approve)

Keep **Material Glass / Material You hierarchy with soft Aero** — the shell, composer and Settings already read
as one family and should stay recognisable.

1. **One surface, then content.** Each region owns one background level. Cards are for genuinely separable
   objects (a message, a diff pane, a settings group), not for wrapping every section.
2. **Chrome recedes.** Borders only where they separate interactive regions; no nested grey panels; no card
   inside a card inside a panel.
3. **Primary actions look primary.** Exactly one filled accent action per surface; destructive actions are
   red and never share styling with neutral actions.
4. **Desktop density.** 26–30 px rows, 12–13 px body text, 4 px spacing grid. No oversized controls, no
   decorative empty space.
5. **Glass is a background treatment, not a foreground one.** Blur stays on the shell and on modal backdrops;
   never behind text that must be read for long.
6. **Motion is feedback.** 120–180 ms, opacity/transform only, disabled under `prefers-reduced-motion`.
7. **Docked over floating.** Explorer, editor and terminal occupy space; dialogs are reserved for decisions
   (diff review, confirmations, settings).

---

## 5. Proposed design tokens (3Q-2 implementation)

Additive to the existing `--theme-*` set so custom themes keep working; `theme.ts` validation must be extended
deliberately (see §11, K-9).

**Colour** (dark defaults; light overrides mirror the 2026-11-04 palette):

```
--surface-0   #17191f   app background / canvas
--surface-1   #1d2027   panels (rail, explorer, editor, terminal)
--surface-2   #242730   raised rows, inputs, code blocks
--surface-3   #2d303a   popovers, menus, hovered raised rows
--line-1      #2b2f3a   hairline separators (replace most borders)
--line-2      #3b3f4b   focus-adjacent / selected outlines
--text-1      #eceef4   primary
--text-2      #a2a8b6   secondary (7.37:1 on surface-0 — already measured)
--text-3      #767d8d   tertiary, metadata
--accent      #5966d8   primary action, selection
--accent-hover #6b78ea
--accent-ink  #ffffff   text on accent
--ok          #3f9d6d   verified / success
--warn        #c8923c   timeout, cancelled, stale
--danger      #d05a5a   destructive, failed
--focus       #8b96ff   focus ring (2 px, 2 px offset)
```

**Typography.** Replace 19 sizes with 7 steps: `11 / 12 / 13 / 14 / 16 / 20 / 28`. Body 13, metadata 11–12,
section title 16, page title 20, hero 28. Line height 1.35 (dense), 1.5 (prose). Mono: Cascadia Mono 12 for
code and terminal. One UI family (Inter → Segoe UI fallback) everywhere; no per-component font overrides.

**Spacing.** 4 px base with a 2 px hairline exception: `2 / 4 / 6 / 8 / 12 / 16 / 20 / 24 / 32`
(`--space-1…9`). Row padding 6×10, panel padding 12–16, section gap 16–24.

**Radii.** Five values only: `6` (chips, small controls), `8` (inputs, buttons), `12` (cards, popovers),
`16` (panels, modals), `999` (pills). The current 20 values collapse into these.

**Elevation.** `--shadow-1` popover, `--shadow-2` modal, `--shadow-3` window shell; `--inset` for pressed
states. No other shadows.

**Borders.** `--line-1` 1 px default; no border on cards that sit directly on `--surface-0`.

**Motion.** `--dur-fast 120ms`, `--dur-base 180ms`, `--ease cubic-bezier(.2,.6,.3,1)`; all transitions use the
tokens; `@media (prefers-reduced-motion: reduce)` zeroes them globally (not just the easter egg).

**Focus.** One ring: `outline: 2px solid var(--focus); outline-offset: 2px`.

---

## 6. Reusable component inventory (3Q-2 builds these; nothing else)

| Primitive | Variants | Replaces |
| --- | --- | --- |
| `Button` | primary, secondary, ghost, danger, link; sizes sm/md | `.btn-ok`, `.btn-no`, `.btn-yes` (new), `.ghost`, `.link`, ad-hoc pills |
| `IconButton` | plain, danger; requires `aria-label` | icon-only buttons across rail/tree/titlebar |
| `Field` | label + control grid, hint, error | settings/providers/model forms |
| `Panel` | surface level 0/1/2, optional header | nested card wrappers |
| `Card` | flat, interactive | Automations blocks, history rows |
| `Tabs` | underline, pill | editor tabs, settings nav (keep current ARIA) |
| `Popover`/`Menu` | anchored, keyboard-complete | 4 bespoke popovers |
| `Dialog` | dialog, confirm (danger), focus trap | `.modal`, `window.confirm` ×14 |
| `Toast` | info/warn/error, `aria-live` | `.toast` |
| `StatusChip` | ok/warn/danger/muted + dot | risk chips, exec status, tree markers |
| `EmptyState` | icon, title, body, action | search (model), tree, marketplace, history |
| `Skeleton`/`Spinner` | inline, block | "Opening…", "Loading workspace…", terminal connect |
| `SplitPane` | resizable, persisted widths | explorer/editor, terminal dock height |

Integration: plain Preact function components in `ui/src/components/ui/`, class names consumed from
`styles.css`, no CSS-in-JS, no new runtime dependency. `store.ts` stays the single state container.

**Inventory scope (clarified 2026-11-08, review follow-up).** This table is the inventory for all of 3Q-2, not for
3Q-2a alone. `Tabs` shipped in 3Q-2a (extracted from the editor's inline strip, which is its first real consumer).
`SplitPane` is deferred to 3Q-2b because it has **no consumer** in 3Q-2a — nothing in the current codebase has a
resizer — and building it earlier would be an unused abstraction.

---

## 7. File manager: interaction audit and revised specification

This section replaces the earlier layout-first draft. The user's feedback was that Files does not communicate what
can be done with a file; that is an interaction defect, so the audit below is about behaviour, not styling.

### 7.1 What the rows actually do today (code-verified)

| Gesture | Current behaviour | Evidence |
| --- | --- | --- |
| Single click, file | If the file is not yet open: fetch `ui_file_preview` and **open the preview modal over the tree**. If it is already open as a document: activate its tab. | `FileTree.tsx` `toggle()` (`!node.dir` branch), live `03-file-preview.png` |
| Single click, folder | Expand/collapse, lazy-loading children on first open. | `toggle()` (dir branch) |
| Double click, file | **No handler.** `onDblClick` does not exist in the component, so the second click repeats the preview fetch (or re-activates the tab). It has no distinct meaning. | grep: 0 `onDblClick` in `FileTree.tsx` |
| Right click | **No handler.** `onContextMenu` does not exist anywhere in the workspace UI. | grep: 0 `onContextMenu` |
| `Enter` / `Space` | Routed through `treeKeyAction` → `toggle`, i.e. exactly the same as a click: preview modal for files, fold for folders. | `onTreeKeyDown` (line 364) |
| Arrow keys / Home / End | Roving focus between visible rows; `→`/`←` fold and focus. This part works well. | `onTreeKeyDown`, `fileTree.ts` |
| Selected row | `.ft-row-selected` (`rgba(79,109,255,.14)`) **is** applied to the previewed file — but the preview modal is open on top of it, so the selection is never visible while browsing. | `FileTree.tsx:745`, `styles.css:310` |
| Hover | `.ft-row:hover` background. | `styles.css:309` |
| Focus | `.ft-row:focus-visible` 2 px outline. | `styles.css:311` |
| Share with chat | Header button shares the **active editor document** (CP9 capture of the current draft), not a selected row. It is meaningless until a document is open in the editor. | `FileTree.tsx:510`, `shareEditorWithAgent()` |

**Conclusion.** The interface is not gated by missing capability — it is gated by a single modal. There is exactly
one action available on a file (preview), it is delivered as a blocking overlay, and it hides the only selection
feedback that exists. That is why filenames read as labels: nothing changes at the moment of the click except that
the page is covered. Double-click, right-click, explicit selection and "use this file in chat" are genuinely absent,
not merely unstyled.

### 7.2 Supported vs missing actions (must not promise what the backend cannot do)

| Action | Backend | UI today | Decision |
| --- | --- | --- | --- |
| Preview / read | `ui_file_preview` (paged), `ui_file_text` | Modal | **Keep capability, move into a docked pane** |
| Open in editor | `ui_file_text` + tab store | Only via `Edit` inside the modal | **First-class: double-click / Enter** |
| Edit + save | `ui_file_save` with mandatory `expected_original`, DiffModal gate | Yes | **Preserve exactly** |
| Share with chat | CP9 capture (current draft or selection, JSON-framed) | Header button, editor only | **Add for the selected file**; text source must be stated (see Q4) |
| Select without opening | UI state only | Conflated with preview | **Build a real selection** |
| Copy path | Frontend clipboard | None | **Add** (no backend needed) |
| Reveal in Explorer | `ui_workspace_open_in_explorer` — **workspace root only** | Workspace-level | Do not offer per-file reveal until a Rust command exists |
| Rename file (F2) | **No command** | None | **Out of scope**; future work needing a new confined Rust command + tests |
| Delete file | **No command** | None | **Out of scope**, same reason |
| New file / new folder | **No command** | None | **Out of scope**, same reason |
| Drag and drop | No destination semantics | None | Omit |

The command surface is `ui_tree`, `ui_file_preview`, `ui_file_text`, `ui_file_save` only. Any menu that offers
rename, delete or create would be a promise the application cannot keep, so the 3Q-2 menu contains only the actions
above that exist.

### 7.3 Interaction contract (revised)

| Gesture | New behaviour |
| --- | --- |
| Single click | Select the row (visible immediately, no overlay) and load its preview into the editor pane's **preview state**. |
| Double click | Open the file in an editor tab (focus it if already open). |
| `Enter` | Open in editor. |
| `Space` | Toggle preview for the selected row without opening a tab. |
| `↑ ↓` | Move selection (and preview, debounced). |
| `→` | Expand folder. It never opens a file. |
| `←` | Collapse folder, or move to the parent. It never closes a tab. |
| Right click / `Shift+F10` | Context menu: Open in editor · Preview · Copy relative path · Copy absolute path · Share with chat. Nothing else. |
| Header actions | Filter, Share selected with chat, Refresh, Collapse. |
| Tabs | Click to activate; middle-click or `×` to close; `Ctrl+W` closes the active tab (existing). |

Selection must be visually distinct from hover and from the active tab: selected = accent tint + 2 px accent
left edge; active tab = the file shown in the editor; hover = neutral lift. The three states are deliberately
different because they answer different questions ("what did I click", "what am I editing", "what is under the
cursor").

### 7.4 Layout

```
┌ rail ┬──────────────────────────────────────────────────────────────────────┐
│      │ titlebar: workspace / task · terminal · window                        │
│      ├──────────────────────────────────────────────────────────────────────┤
│      │ ┌ explorer 240–320 ─┐┌ editor ─────────────────────────────────────┐ │
│      │ │ filter…  [＋][⟳] ││ tabs: app.ts ●  math.ts                     │ │
│      │ │ ▾ src            │├──────────────────────────────────────────────┤ │
│      │ │   ▾ lib          ││ CodeMirror (or preview for selected file)     │ │
│      │ │     math.ts      ││                                              │ │
│      │ │   app.ts  ▸      ││                                              │ │
│      │ │ README.md        │├──────────────────────────────────────────────┤ │
│      │ │                  ││ 42 lines · 1.2 KB · saved · save is reviewed │ │
│      │ └──────────────────┘└──────────────────────────────────────────────┘ │
│      │ ┌ terminal dock (resizable) ───────────────────────────────────────┐ │
│      │ │ PowerShell · workspace                     Live            [×]  │ │
│      │ └──────────────────────────────────────────────────────────────────┘ │
└──────┴──────────────────────────────────────────────────────────────────────┘
```

- Explorer `clamp(220px, 22vw, 320px)`, resizable via a 4 px splitter, width persisted.
- Editor fills the remainder; tabs sit **above** it, sharing its surface (no floating bar).
- Preview is a state of the editor pane (read-only), not a modal. A dirty tab **never** blocks or delays previewing
  another file: every tab stays mounted with its draft, cursor and scroll intact, selection only changes what the
  preview shows, and returning to a tab restores its editor state. No draft is ever closed, discarded or
  overwritten by selecting a file.
- Terminal docks beneath the editor only, `clamp(180px, 30vh, 420px)`, drag handle, collapse button.
- At the 900 × 560 minimum window: explorer collapses to icons below 260 px, terminal collapses to its header.

### 7.5 Row anatomy and states

`caret 16` · `file-type icon 16` (seven groups: folder, code, test, doc, data/json, media, other) · `name` ·
`meta` (size) · `dirty dot` · `agent-changed` 2 px left edge. Row height 26 px, indent 14 px per level with a
1 px guide line, one background per tree, no per-row borders.

| State | Treatment |
| --- | --- |
| Default | transparent, `--text-1` name, `--text-3` meta |
| Hover | `--surface-2`, pointer cursor |
| Selected | `--accent` 14% tint + 2 px accent left edge; `aria-selected="true"` |
| Focus (keyboard) | 2 px `--focus` ring, inset offset |
| Active tab's file | accent text weight, no tint (distinguishes "open" from "selected") |
| Agent-changed | accent-tinted left edge + tooltip with the change provenance |
| Unreadable | inline `Couldn't load — retry` in danger colour |
| Disabled | not applicable — no unsupported actions are shown |

### 7.6 Preview pane contents

Header: file name, workspace-relative path, type + size, and the actions **Open in editor**, **Share with chat**,
**Copy path**. Body: read-only syntax-highlighted content for known text types (reuse the CodeMirror host in
read-only mode; do not add a second editor), paged for large files using the existing `ui_file_preview` offsets,
plain monospace for unknown types, and an explicit "binary — preview not available" state instead of mojibake.
Footer: the existing honest line/page indicator.

No modal is opened by browsing. Modals remain for decisions: the diff gate, dirty-close confirmation, and settings.

### 7.7 Discoverability specifics (the actual complaint)

1. Rows must visibly react to hover and selection before anything loads.
2. The editor pane's empty state reads: "Select a file to preview it · Double-click to open it in the editor",
   with the keyboard equivalents. This is the only new copy needed to make the workflow self-explanatory.
3. The explorer header labels its own actions (filter placeholder text, icon tooltips, share button text at wide
   widths) rather than relying on four unlabelled glyphs.
4. `Share with chat` appears both in the pane header and in the row context menu so the connection between a file
   and the composer is explicit; the composer then shows the attachment as it already does for editor context.
5. The tree keeps `aria-selected` and gains `aria-expanded` on folders.

### 7.8 Behaviours that must not change

Preview/read still comes from Rust (`ui_file_preview`/`ui_file_text`), saving still goes only through
`DiffModal` → `ui_file_save` with the exact baseline, tabs keep one CodeMirror instance per document with hidden-
but-mounted inactive documents, drafts survive tab switches and agent writes, the explorer keeps its deterministic
sort, 400-entry cap with an honest notice, loading/empty/error/retry states, stale-response rejection, event-driven
refresh after verified writes, and no polling.

### 7.9 Preview cache and invalidation

Selection-driven reads are debounced (~120 ms) and cached per canonical path for the session. A cached entry is
dropped when any of the following happens, so a preview can never show content older than an event the app
itself observed:

- a successful user save (`ui_file_save` resolved);
- a verified agent write (`file-changed` event that passed verification);
- an explicit explorer refresh;
- a workspace switch (the whole cache is cleared, not just the changed paths).

Nothing is prefetched for collapsed folders, and no cache entry is served after `agentChangeTick` advances for
its path.
## 8. Application-wide layout recommendations

1. **Content widths.** Chat column `max-width: 760px`, centred; composer matches; launcher cards collapse to
   one column below 900 px.
2. **Rail popovers dock** (push the content) at 280 px, or gain a scrim; never overlay readable text (S-*).
3. **Titlebar** shows task title + read-only state in `task` view, workspace name otherwise, and the view name
   only where neither applies.
4. **Automations** becomes one page with a section header and three flat sections (state, live output,
   history) separated by hairlines, not four cards.
5. **Execution history** becomes a table-like list: columns status · tool · path · duration · exit, with a
   filter row, keeping the `<details>` expansion for args/output.
6. **Settings** keeps its skeleton; introduce a fixed label column, 640 px content, and danger styling on
   destructive rows.
7. **Terminal** gains a 32 px header aligned to the grid, a resize handle, and a `Connecting…` state (already
   present in source) before the first byte.

---

## 9. Accessibility and keyboard plan

- Single focus token applied to every interactive element (`:focus-visible`).
- `Dialog` primitive: focus trap, initial focus, restore to trigger, Escape, `aria-modal`.
- `Popover` primitive: Escape, outside click, `ArrowUp/Down`, `Home/End`, `Enter` activate, `Tab` closes.
- File tree: keep the current roving-focus/ARIA model; add `aria-level`, `aria-expanded`, `aria-selected`.
- Toasts: `role="status"` / `aria-live="polite"`; errors `role="alert"`.
- Contrast: re-sample both themes after tokenisation; target ≥ 4.5:1 for body, ≥ 3:1 for large text and
  control borders.
- `prefers-reduced-motion` zeroes all transitions and forces instant scroll.
- Keyboard-only walkthrough at 900×560 (min window) before 3Q acceptance.

---

## 10. Prioritised implementation sequence (revised: selection first)

The order changes after the feedback. File selection, preview and the explorer/editor relationship come first;
home, settings and decorative work wait until that workflow is clear.

### 3Q-2a — Foundation subset (small, no layout change)
Only what the file workspace needs: the token block (§5), `Button`/`IconButton`/`Panel`/`Tabs`/`EmptyState`
primitives, and the missing `.btn-yes` rule (W-1) so `Apply change` reads as the primary action.
No screen is rearranged in this step; captures must show identical geometry with corrected affordances.
*Gate: no literal colours outside the token block; both themes render; existing suites pass.*

**Amended 2026-11-08 (review follow-up):** `SplitPane` moved from 3Q-2a to 3Q-2b. `Tabs` was delivered in 3Q-2a by
extracting the editor's existing strip, so it had a real consumer; `SplitPane` has none until the docked workspace
exists, and a resizer built with nothing to resize would be a placeholder. 3Q-2b therefore owns both the docked
layout and the `SplitPane` primitive that it needs.

### 3Q-2b — Docked file workspace (the milestone)
Explorer/editor split with a persisted width; persistent selection with hover/selected/focus/active states;
inline preview pane; open-in-editor on double-click and Enter; tabs above the editor; row context menu limited to
supported actions; share-with-chat from the pane header; terminal docked with a drag handle.
*Gate: a first-time user can select a file, see it, open it in a tab, edit it, review the diff and share it with
chat without a modal interrupting browsing; keyboard-only path works; K-1…K-11 hold; no measured regression in
tree or editor behaviour.*

### 3Q-3 — App-wide integration (after the workflow is proven)
Chat markdown + verdict card + composer spacing (C-1…C-4), diff pane captions and button hierarchy (W-7),
Automations/history hierarchy (T-3), settings field rows and danger styling (T-1), shell affordances (S-5, S-6),
in-app confirm dialogs (C-5).

### 3Q-4 — Accessibility, motion and acceptance
§9 in full, reduced-motion tokens, contrast re-sample in both themes, keyboard walkthrough at 900 × 560,
screenshot regression against this audit's baseline, and a final measurement pass.

**Explicitly deferred:** rename/delete/new-file (no backend command), per-file reveal, drag and drop, multi-select,
light-theme redesign, and any change to the home screen or settings beyond the items listed in 3Q-3.

## 11. Compatibility constraints (must not regress)

- **K-1** `DiffModal` remains the only path to `ui_file_save`; `expectedOriginal` stays mandatory and exact.
- **K-2** Approval gating, rejection, cancellation and exactly-once execution are untouched by styling work.
- **K-3** Workspace confinement: no frontend filesystem access; all reads/writes through Rust commands.
- **K-4** Explorer correctness: deterministic sort before the 400-entry cap, honest loading/empty/error,
  stale-response rejection, expansion preserved on refresh.
- **K-5** Editor semantics: one CodeMirror instance per document, hidden-but-mounted inactive tabs, drafts and
  cursor preserved across tab and view switches, dirty-close confirmation, no draft loss on agent writes.
- **K-6** Agent-change handling: verified-write events only, session-scoped markers, clean tabs reload, dirty
  drafts preserved, reconcile on mount after a missed event.
- **K-7** Terminal lifecycle: one PTY per drawer, kill on workspace change and window destroy, output cap and
  best-effort ordering unchanged, retry path preserved.
- **K-8** Execution history attribution: task/workspace identity from the transcript, six statuses, observed
  exit codes only.
- **K-9** Theme compatibility: `theme.ts` validates token names, so adding tokens must extend `THEME_TOKENS`
  and the parser together; existing custom themes must keep loading.
- **K-10** Editor-context sharing stays explicit, unsaved-buffer based, JSON-framed inside one user message,
  cleared on workspace/task change.
- **K-11** No polling or filesystem watchers; no new runtime dependency for styling.
- **K-12** Selecting a file in the tree never discards a dirty tab or an unsaved draft; a selection changes what is previewed, not what is open.

---

## 12. Approved decisions (2026-11-08, user review)

| # | Question | Decision |
| --- | --- | --- |
| 1 | Preview placement | Editor-pane state; no permanent side-by-side pane. |
| 2 | Selection read policy | ~120 ms debounce + session cache, with invalidation as specified in §7.9. |
| 3 | Share source | A selected-but-unopened file shares disk text, labelled **On disk**; open documents keep sharing their current draft. |
| 4 | Rename / delete / new file / new folder | Deferred: they require confined Rust commands and their own tests. |
| 5 | Per-file Reveal in Explorer | Deferred until the backend supports it. |
| 6 | `.btn-yes` with no CSS rule | Confirmed bug; fixed in 3Q-2a. |
| 7 | Light theme | Capture before freezing token values; dark and light both verified in 3Q-2a. |
| 8 | Terminal | One session for this milestone; dock height persists, the process does not. |

Additional corrections accepted: right-arrow never opens a file; a dirty tab never blocks previewing another
file; cached previews must be invalidated on save, verified agent write, explicit refresh and workspace change.
## 13. Confirmations

Revision R1 (user feedback) was applied the same day: sections 3, 7, 10 and 12 updated, no other section
rewritten.


- No source, stylesheet, component, dependency or persisted user setting was modified; the shipping
  `com.neelima.app` profile was never opened.
- The disposable fixture workspace lived under the OS temp root and was deleted after capture; the isolated
  acceptance profile remains test-only configuration.
- No commit, push, reset, clean, stash, revert or branch switch.
- Working tree unchanged in code terms: branch `fix/vite-security`, HEAD `320a322`, 0 staged, 43 modified
  tracked files. Only `.tmp/3q1-audit/` evidence and this document were added.

---

## 14. 3Q-2a implementation record (2026-11-08)

Foundation only. No screen was re-laid-out, no file-manager interaction changed, and no chat, Automations or
settings surface was touched. Everything below is either a token/primitives addition or a button-hierarchy fix.

### 14.1 Measurement correction to section 3 (found during 3Q-2a capture)

W-2 and the inventory paragraph said the explorer is **272 px**. That number came from the first `.filetree`
rule in `styles.css`; a later rule, `width: min(100%, 720px)`, is the one that actually applies. Measured in the
running application: `.filetree` = **720 × 591** inside a 1027 px main panel, leaving ~307 px empty to the right.
Both statements are corrected above. The defect itself stands (the workspace still wastes a third of the content
area and the document still opens as a centred modal); only the number was wrong.

### 14.2 Token layer (`ui/src/styles.css`, block "Phase 3Q-2a — design foundation")

Semantic colour is **derived** from the eight themeable `--theme-*` values, so existing custom themes keep
working with no migration:

| Group | Tokens |
| --- | --- |
| Surfaces / lines / text | `--surface-0..3`, `--line-1`, `--line-2`, `--text-1..3`, `--accent`, `--accent-ink`, `--danger`, `--ok`, `--warn` |
| Spacing (4 px base + hairline) | `--space-1..9` (2, 4, 6, 8, 12, 16, 20, 24, 32) |
| Type | `--text-xs..3xl` (11, 12, 13, 14, 16, 20, 28) |
| Radii | `--radius-sm/md/lg/xl/pill` (6, 8, 12, 16, 999) |
| Motion | `--dur-fast` 120 ms, `--dur-base` 180 ms, `--ease-standard` |
| Elevation / focus | `--shadow-1`, `--shadow-2`, `--focus-ring` |

`--text-3` deliberately mirrors `--text-2` until 3Q-2b introduces a true tertiary tone, so no component can
invent a colour. No new themeable token name was added: `theme.ts` still accepts exactly `THEME_TOKENS` (8).

### 14.3 Primitives (`ui/src/uiPrimitives.ts`, `ui/src/components/ui/`)

Class mappings are pure and unit-tested; the components are thin wrappers over **existing** class names so
adoption changes no markup and no geometry.

| Primitive | Variants / props | Emitted classes |
| --- | --- | --- |
| `Button` | `primary`, `secondary`, `ghost`, `danger`, `link` (unknown → `ghost`) | `btn-yes`, `btn-no`, `ghost`, `ghost danger`, `link` |
| `IconButton` | required accessible name | `ghost icon-button` |
| `Panel` | `level` 0/1/2 (clamped) | `panel panel-0..2` |
| `EmptyState` | `title`, `children` | `empty-state` |
| `StatusChip` | `ok`, `warn`, `danger`, `muted` (clamped) | `chip chip-*` |
| `Tabs` | `items`, `active`, `ariaLabel`, `onActivate`, optional `onClose` (no close control when omitted) | `editor-tabs`, `editor-tab[-active|-idle][ -editor-tab-dirty]` |

Adopters: `DiffModal`'s Apply button uses `Button variant="primary"`; the editor tab strip in `FileTree.tsx` now
renders through `Tabs` instead of an inline copy. No other screen was migrated; that belongs to 3Q-2b/3Q-3.

`Tabs` was added in the review follow-up and is a pure extraction: same element types, classes, ARIA, tooltips,
keyboard handling (Enter/Space activate; arrows are still untouched) and dirty marker. Verified two ways — six
jsdom interaction tests, and a rebuilt binary whose dark and light captures are **byte-identical** to the
pre-extraction PNGs, with `.editor-tabs` measuring 918 × 33 and the single tab 78 × 32 in both builds.

### 14.4 Button hierarchy: two defects, not one

**W-1 (`.btn-yes` had no rule) — fixed.** `.btn-yes` now fills with `--accent`, uses `--accent-ink`, keeps the
existing `5px 14px` padding and 8 px radius, brightens on hover, dims to 0.5 when disabled, and takes the shared
focus ring.

**A second defect found while verifying it.** `.btn-no` is declared twice: a dark secondary `#33343b` (~line 275)
and an **unconditional** light one `#f0eef6` (~line 844) that comes later in the file and therefore won in *both*
themes. In dark theme "secondary" rendered as a bright light pill that out-shouted the new filled primary, so
`Review & save` / `Apply change` still did not read as the main action. A scoped
`[data-theme="dark"] .btn-no` restores the dark secondary the file already intended. Colour only — padding,
radius and size untouched.

Measured in the running application (dark, enabled):

| Control | Background | Text | Geometry |
| --- | --- | --- | --- |
| `Review & save` / `Apply change` (primary) | `rgb(89, 102, 216)` | white | `5px 14px`, 8 px radius |
| `Close all` / `Cancel` (secondary) | `rgb(51, 52, 59)` | `rgb(236, 238, 244)` | `5px 14px`, 8 px radius |

Light theme keeps its existing secondary (`rgb(240, 238, 246)` on `rgb(54, 60, 75)`).

`Review & save` is disabled until the draft is dirty (opacity 0.5) — pre-existing behaviour, unchanged: with a
dirty draft it measures opacity 1 and enabled.

### 14.5 Theme compatibility and capture

Capture driver: `.tmp/3q2a/shots.js` over CDP against the isolated acceptance instance
(`.tmp/3q2a/launch.ps1`; identifier `com.neelima.cp10acceptance`, WebView2 profile in the OS temp dir — the
shipping `com.neelima.app` profile is never opened). Every run reloads first, so no run can inherit the other
theme or an open tab.

| Check | Dark | Light |
| --- | --- | --- |
| `data-theme` | `dark` | `light` |
| `--theme-bg` / `--surface-1` | `#17191f` / `#242730` | `#e8e4f5` / `#fff` |
| Sidebar | 72 × 702 | 72 × 702 |
| Main panel | 1027 × 650 @ (84, 40) | 1027 × 650 @ (84, 40) |
| File tree | 720 × 591 | 720 × 591 |
| Preview modal | 920 × 207 | 920 × 207 |
| Diff modal buttons | Apply filled / Cancel dark | Apply filled / Cancel light |
| Reduced motion | `transition-duration` 1e-06 s, media matches | same |

Geometry is identical across themes and identical to the 3Q-1 baseline, so 3Q-2a changed no screen geometry.

Evidence: `.tmp/3q2a/dark-01-home.png`, `dark-02-files.png`, `dark-03-preview.png`, `dark-04-editor.png`,
`dark-04b-editor-dirty.png`, `dark-05-diff.png` and the `light-*` equivalents, plus `dark-report.json` /
`light-report.json` (the raw measurements above).

### 14.6 Custom-theme compatibility

`parseCustomTheme` is unchanged. Tests assert that: a legacy 8-token JSON theme loads and yields exactly
`THEME_TOKENS.length` colours; a partial theme is accepted; an unknown name (`--surface-1`) is still rejected;
CSS `:root { … }` themes behave identically. Because the semantic layer derives from `--theme-*`, a custom theme
restyles the new tokens automatically.

### 14.6b Review follow-up (2026-11-08): primitives, test count, Rust evidence

**`Tabs` and `SplitPane`.** The §6 inventory is for all of 3Q-2; §10 had listed both in 3Q-2a, so the omission was a
real deviation from the approved sequence.

- *Audit first.* The editor tab strip existed only as a local `EditorTabs` function inside `FileTree.tsx`; there was
  no reusable component. No resizer exists anywhere in `ui/src` (`resizer`, `split-pane`, `SplitPane`,
  `drag-handle`: zero matches); `TerminalPanel` only observes browser/`ResizeObserver` resizes, and the explorer
  width is fixed.
- *`Tabs` — implemented in 3Q-2a.* It has a real consumer (`EditorTabs`), so extraction is not an abstraction: the
  primitive emits exactly the previous markup, and `FileTree` now renders through it.
- *`SplitPane` — deferred to 3Q-2b* and removed from the 3Q-2a list in §10. It has no consumer until the docked
  workspace exists; building a resizer with nothing to resize would be the placeholder this review forbids. It is
  the first primitive 3Q-2b builds, alongside its consumer.

**Test-count arithmetic corrected.** 165 → 179 is **+14**, not +13: `ui/tests/uiPrimitives.test.js` contains 14
tests (variant mapping ×2, unknown-variant safety, extra classes, icon buttons, panel clamping, chip clamping,
legacy theme, partial theme, unknown-token rejection, CSS theme, `.btn-yes` rule, dark-secondary override, reduced
motion). The follow-up addition is a separate step: +1 pure tab-class test and +6 jsdom `Tabs` tests, so
179 → **186**. The earlier "+13" wording in §14 and the project log is superseded by this paragraph.

**Rust failure — evidence only, no cause claimed.** What is recorded: (a) the first full `npm run test:rust` exited
101 with one failure, `skills::tests::local_install_update_preserves_edits_and_recovers_failed_staging`, assertion
`install_downloaded(...).is_ok()` at `skills.rs:1129` (`test result: FAILED. 282 passed; 1 failed`); (b) the same
test passed 3/3 when run alone (`cargo test --lib ...`); (c) a full rerun exited 0 with 348 passed, 0 failed. No
Rust code was touched, and the original log is preserved at `.tmp/3q2a/test-rust.log` with the green rerun at
`.tmp/3q2a/test-rust-2.log`. The earlier "ordering-sensitive" description was an inference, not a demonstrated
root cause, and is withdrawn.

### 14.7 Deliberately not done in 3Q-2a

No docked editor, no inline preview pane, no row selection/context menu, no terminal dock/resize, no chat,
Automations or settings redesign, no new dependency, no CSS-in-JS. Rename/delete/new-file/reveal/drag stay
deferred (no backend commands exist). `.btn-ok` has the same double-declaration problem as `.btn-no`; it is left
alone because it is not part of the 3Q-2a hierarchy claim and is recorded for 3Q-3.
---

## 14. 3Q-2b — implementation record (2026-11-08)

### What was implemented

The workspace interaction contract in §7–§9 is now the shipping behaviour of the Files
surface: docked resizable explorer, editor pane, inline preview as an editor-pane state,
tabs that never lose a draft, and a five-action context menu limited to commands the
backend actually has (`ui_tree`, `ui_file_preview`, `ui_file_text`, `ui_file_save`).
The preview modal is gone from ordinary browsing; the diff review and the unsaved-close
confirmation remain modal because they are decisions, not navigation.

### Decisions taken during implementation

1. **Preview is a pane state, not a mode.** Selecting a file while a dirty tab exists
   shows the preview and keeps every document mounted (`doc-editors` is hidden, not
   unmounted), so returning to a tab restores its CodeMirror view untouched.
2. **Selection of an open file activates its tab** rather than previewing a duplicate of
   a file that is already on screen — the title then says `· unsaved draft` or `· saved`.
3. **Cache invalidation restarts a pending selection.** The workspace-tag effect calls
   `invalidateAll()` when a document opens; without a restart, a preview requested in the
   same tick would sit on "Loading preview…" with no read in flight. A genuine workspace
   switch clears the selection first, so another workspace's read is never revived.
4. **Activation reads the store, not the render snapshot.** A click can land before the
   deferred render carrying the newest draft; using `editorState.editorDocs` from the
   closure silently reverted typed text in that window.
5. **Paths are copied, not opened in a system file manager.** "Copy absolute path" uses
   the workspace root's own separator; reveal-in-explorer stays deferred until a backend
   command exists.
6. **The splitter persists on commit, not on every pointer move** (`settingsSet` once per
   gesture; keyboard steps commit immediately), and a stored value is re-clamped on read
   because it may come from a different window size.

### Token/stylesheet note

The only stylesheet defect this milestone exposed was pre-existing and unrelated to the
new tokens: `.file-preview-head > div` (added for the title block) outranked
`.file-preview-actions`, so the preview's actions rendered as a vertical column. The
selector now excludes the action row, and a stylesheet test pins that.

### Evidence

`.tmp/3q2b/` — `evidence.md`, `verify.js` (CDP driver), `setup.js` / `cleanup.js`
(disposable workspace lifecycle), `acceptance-build*.log`, `tauri-debug-build.log`, and
seven dark/light PNGs. Mounted coverage lives in `ui/tests/fileTree-jsdom.test.js`;
pure coverage in `previewCache.test.js`, `splitPane.test.js`, `fileMenu.test.js`.

### Still deferred

Rename/delete/new file-folder, per-file reveal, drag-and-drop, filesystem watchers,
terminal docking and multi-session terminals. The 400-entry listing cap, 2 MiB
approval-gated write limit and share-time snapshots for editor context are unchanged.
