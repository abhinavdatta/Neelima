// Files workspace: docked explorer + editor pane (Phase 3Q-2b).
//
// Interaction contract (docs/PHASE3Q-1-DESIGN-AUDIT-2026-11-08.md §7):
//   single click  select the row and preview it inline (no modal)
//   double click  open it in an editor tab
//   Enter         open in editor        Space  toggle the inline preview
//   arrows        move selection (and preview, debounced) / fold folders
//   right click, Shift+F10  file context menu (only supported actions)
//
// What deliberately did NOT change: the editor is still one hidden-but-mounted
// CodeMirror per document, saving still goes only through DiffModal →
// ui_file_save with the exact baseline, agent-change reconciliation still runs
// on verified events (no polling), and the tree stays lazy with its 400-entry
// cap and honest notices. Selecting or previewing a file never touches a draft.
//
// Preview reads are owned by previewCache.ts: ~120 ms debounce, per
// workspace+path session cache, and invalidation on save / verified agent write
// / explicit refresh / workspace switch. Stale responses are discarded there.
import { useEffect, useRef, useState } from "preact/hooks";
import { getState, setState, toast, useStore } from "../store";
import { cmd } from "../tauri";
import { editBlockReason, editStatus } from "../fileEdit";
import {
  changeSummary, mergeListing, reconcileDocsAfterExternalWrite, refreshDirFor,
} from "../agentChanges";
import {
  DocRec, SAVE_CONFLICT_PREFIX, closeDocument, cycleActive,
  docsAfterConflictRebase, docsAfterSave, docDir, docName, docDirty, openDocument, tabKeyAction,
} from "../editorTabs";
import { Icon } from "./Icon";
import { Tabs } from "./ui/Tabs";
import { SplitPane } from "./ui/SplitPane";
import { EmptyState } from "./ui/EmptyState";
import { addEditorContext, buildEditorContext } from "../editorContext";
import { captureEditorSelection, findEditorRoot } from "../editorContextCapture";
import { createPreviewController } from "../previewCache";
import type { PreviewController, PreviewData } from "../previewCache";
import {
  SPLIT_DEFAULT_WIDTH, clampSplitWidth, normalizeStoredSplitWidth, splitBounds,
} from "../splitPane";
import { absoluteWorkspacePath, fileMenuItems, menuIndexForKey } from "../fileMenu";
import type { FileMenuAction } from "../fileMenu";
import {
  TreeMeta, TreeNode, applyListing, expandedDirPaths, listingMeta, listingNotice,
  nodesFromEntries, replaceNode, setNodeError, treeKeyAction, visibleRows,
} from "../fileTree";

interface FilePreview extends PreviewData {}

export function FileTree() {
  const s = useStore();
  const [roots, setRoots] = useState<TreeNode[]>([]);
  const [show, setShow] = useState(true);
  // Inline preview: the pane shows this file's on-disk content while every open
  // editor document stays mounted (hidden) with its draft, cursor and scroll.
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewPath, setPreviewPath] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Real selection, independent of the preview: it survives while the preview
  // reloads, and it is what the context menu and the header share act on.
  const [selectedPath, setSelectedPath] = useState("");
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [openingEditor, setOpeningEditor] = useState(false);
  // Unsaved-close confirmation: the document awaiting the user's decision.
  const [confirmClose, setConfirmClose] = useState<string | null>(null);
  const [explorerWidth, setExplorerWidth] = useState(SPLIT_DEFAULT_WIDTH);
  const [containerWidth, setContainerWidth] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const widthInitialized = useRef(false);
  // Trees are loaded per workspace with a generation guard: a response that
  // arrives after a workspace switch or a newer refresh is discarded, so a
  // slow request can never inject another tree's paths into the current one.
  const treeGen = useRef(0);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  // Verified agent writes already reconciled in this workspace. Keys are
  // task/call/path, so a replayed event is a no-op; the sets reset with the
  // workspace because their paths belong to that tree.
  const handledChanges = useRef(new Set<string>());
  const warnedDocPaths = useRef(new Set<string>());
  const [agentChanged, setAgentChanged] = useState<Record<string, { title: string; at: number }>>({});
  const [treeStatus, setTreeStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [treeError, setTreeError] = useState<string | null>(null);
  const [rootMeta, setRootMeta] = useState<TreeMeta | null>(null);
  const [loadingDirs, setLoadingDirs] = useState<string[]>([]);
  const [focusPath, setFocusPath] = useState("");

  const docs: DocRec[] = s.editorDocs ?? [];
  const activeDoc = s.editorActivePath ? docs.find((d) => d.path === s.editorActivePath) ?? null : null;
  const active = activeDoc?.path ?? "";
  const editorOpen = docs.length > 0;
  const dirtyPaths = docs.filter(docDirty).map((d) => d.path);
  const selectedDoc = selectedPath ? docs.find((d) => d.path === selectedPath) ?? null : null;
  // The preview is always a view of the ON-DISK file, so it must say so when the
  // same path also has an open tab (which may hold unsaved edits).
  const selectedDirty = selectedPath ? dirtyPaths.includes(selectedPath) : false;

  const setDocs = (d: DocRec[], act: string) => setState({ editorDocs: d, editorActivePath: act });

  /**
   * Activate an already-open document. Always reads the CURRENT store rather
   * than a `docs` value captured at render time: a click can arrive before the
   * deferred render that carries the newest draft, and writing a stale array
   * back would silently revert text the user just typed.
   */
  const activateOpenDoc = (path: string): boolean => {
    const current = getState().editorDocs ?? [];
    if (!current.some((d) => d.path === path)) return false;
    setDocs(current, path);
    clearPreview();
    return true;
  };

  // One preview controller for this surface. Reads go through the Tauri command
  // only; a response for a selection/workspace that is no longer current is
  // dropped inside the controller.
  const previewRef = useRef<PreviewController | null>(null);
  if (!previewRef.current) {
    previewRef.current = createPreviewController({
      read: (path, offset) => cmd.filePreview(path, offset),
      onState: (state) => {
        if (state.workspace !== getState().activeWorkspacePath) return;
        setPreviewPath(state.path);
        setPreview(state.data);
        setPreviewError(state.error);
        setPreviewLoading(state.loading);
      },
    });
  }
  const previewCtl = previewRef.current;

  const clearPreview = () => {
    previewCtl.cancel();
    setPreviewPath("");
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(false);
  };

  // A workspace switch invalidates every open document (their canonical paths
  // would silently point into another tree) and every cached preview.
  useEffect(() => {
    if (s.editorWorkspaceTag !== null && s.activeWorkspacePath !== s.editorWorkspaceTag) {
      setState({ editorDocs: [], editorActivePath: "", editorWorkspaceTag: null });
      clearPreview();
      setSelectedPath("");
      setMenu(null);
    }
    previewCtl.invalidateAll();
  }, [s.activeWorkspacePath, s.editorWorkspaceTag]);

  // Workspace binding: clear the previous tree IMMEDIATELY (never leave another
  // workspace's paths clickable during a slow/failed load), then load the root
  // under a fresh generation.
  useEffect(() => {
    treeGen.current += 1;
    const generation = treeGen.current;
    setRoots([]);
    setRootMeta(null);
    setTreeError(null);
    setLoadingDirs([]);
    setFocusPath("");
    setSelectedPath("");
    setMenu(null);
    clearPreview();
    rowRefs.current.clear();
    // Reconciliation state is app-session scoped, not ref scoped: a verified
    // change that arrives while the Files surface is unmounted (the user is in
    // chat) must still be reconciled when they come back. Seeding from the
    // store keeps already-handled changes from replaying, while changes seen
    // for the first time are processed by the effect below.
    handledChanges.current = new Set(s.agentHandledKeys ?? []);
    warnedDocPaths.current.clear();
    setAgentChanged({});
    const workspace = s.activeWorkspacePath;
    if (!workspace) { setTreeStatus("idle"); return; }
    setTreeStatus("loading");
    (async () => {
      try {
        const listing = await cmd.tree("");
        if (generation !== treeGen.current) return;
        setRoots(nodesFromEntries(listing.entries));
        setRootMeta(listingMeta(listing));
        setTreeStatus("ready");
      } catch (error) {
        if (generation !== treeGen.current) return;
        setTreeError(String(error));
        setTreeStatus("error");
      }
    })();
  }, [s.activeWorkspacePath]);

  // Explorer width: restored once from settings, then kept in sync with a
  // resized window. The persisted value is clamped again on read, because
  // another window size may have been used when it was written.
  useEffect(() => {
    if (widthInitialized.current || !s.settings) return;
    widthInitialized.current = true;
    setExplorerWidth(normalizeStoredSplitWidth(s.settings.explorer_width));
  }, [s.settings]);

  useEffect(() => {
    const element = rootRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setContainerWidth(element.clientWidth));
    observer.observe(element);
    setContainerWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  const bounds = splitBounds(containerWidth || 760);
  const paneWidth = clampSplitWidth(explorerWidth, bounds);

  const persistWidth = (width: number) => {
    const settings = getState().settings;
    if (!settings) return;
    const next = clampSplitWidth(width);
    if (settings.explorer_width === next) return;
    // Only the width changes: every other setting is sent back untouched.
    cmd.settingsSet({ ...settings, explorer_width: next })
      .then((saved) => setState({ settings: saved }))
      .catch((error) => toast("warn", `Could not remember the explorer width: ${String(error)}`));
  };

  // Refresh re-walks the root AND every successfully expanded directory in
  // parent-first order, merging each listing back into the same tree. Expanded
  // folders stay open, the active preview/documents are untouched, and a
  // failure is reported instead of silently collapsing or resetting the view.
  // It is also one of the events that invalidates cached previews: a refresh is
  // an explicit request for current disk state.
  const refreshTree = async () => {
    if (!s.activeWorkspacePath) return;
    const generation = ++treeGen.current;
    const paths = expandedDirPaths(roots);
    setTreeStatus("loading");
    setTreeError(null);
    setLoadingDirs([]);
    previewCtl.invalidateAll();
    if (previewPath) previewCtl.select(s.activeWorkspacePath, previewPath);
    try {
      let next: TreeNode[] = [];
      let meta: TreeMeta | null = null;
      for (const dirPath of paths) {
        const listing = await cmd.tree(dirPath);
        if (generation !== treeGen.current) return;
        next = applyListing(next, listing);
        if (!dirPath) meta = listingMeta(listing);
      }
      if (generation !== treeGen.current) return;
      setRoots(next);
      setRootMeta(meta);
      setTreeStatus("ready");
    } catch (error) {
      if (generation !== treeGen.current) return;
      // Keep the current tree visible; the banner states the failure honestly.
      setTreeError(String(error));
      setTreeStatus("error");
    }
  };

  // CP6: reconcile VERIFIED agent writes. Each accepted change
  //   • marks its row (full workspace-relative path, so two files with the
  //     same basename stay distinct),
  //   • refreshes only the deepest expanded directory that contains it — no
  //     polling and no full-tree reload,
  //   • reloads an open CLEAN tab from disk, while a dirty draft is preserved
  //     untouched and flagged for the existing conflict-review path,
  //   • drops the cached preview for that path (3Q-2b), so the pane can never
  //     keep showing the pre-change contents.
  useEffect(() => {
    const workspace = s.activeWorkspacePath;
    if (!workspace) return;
    const fresh = (s.agentChanges ?? []).filter(
      (change) => change.workspace === workspace && !handledChanges.current.has(change.key),
    );
    if (!fresh.length) return;
    fresh.forEach((change) => handledChanges.current.add(change.key));
    // Persist the handled keys in the session store so unmounting the Files
    // surface does not discard them (and a later remount can process only the
    // changes that arrived while it was away).
    const handledKeys = [...new Set([
      ...(getState().agentHandledKeys ?? []),
      ...fresh.map((change) => change.key),
    ])].slice(-500);
    setState({ agentHandledKeys: handledKeys });

    setAgentChanged((previous) => {
      const next = { ...previous };
      for (const change of fresh) {
        next[change.path] = { title: changeSummary(change), at: change.at };
      }
      return next;
    });

    const dirs = new Set(fresh.map((change) => refreshDirFor(change.path, expandedDirPaths(roots))));
    const stillThisWorkspace = () => getState().activeWorkspacePath === workspace;
    void (async () => {
      for (const dir of dirs) {
        try {
          const listing = await cmd.tree(dir);
          // A workspace switch invalidates the result completely. A manual
          // refresh of the SAME workspace is not stale data, so it must not
          // cause the verified change to be dropped.
          if (!stillThisWorkspace()) return;
          setRoots((previous) => mergeListing(previous, listing));
          if (!dir) setRootMeta(listingMeta(listing));
        } catch (error) {
          if (!stillThisWorkspace()) return;
          toast(
            "warn",
            `Could not refresh ${dir || "the workspace"} after an agent change: ${String(error)}`,
          );
        }
      }
    })();

    // A verified write makes any cached preview of that path stale. The
    // controller re-reads it only when it is the file currently on screen.
    for (const change of fresh) previewCtl.invalidate(workspace, change.path);

    const paths = new Set(fresh.map((change) => change.path));
    void (async () => {
      for (const path of paths) {
        if (!stillThisWorkspace()) return;
        const open = (getState().editorDocs ?? []).some((doc) => doc.path === path);
        // No open tab: the explorer refresh plus the preview invalidation above
        // is the whole job.
        if (!open) continue;
        let diskText: string;
        try {
          const text = await cmd.fileText(path);
          diskText = String(text?.content ?? "");
        } catch (error) {
          if (!warnedDocPaths.current.has(path)) {
            warnedDocPaths.current.add(path);
            toast(
              "warn",
              `${path} was deleted or became unreadable after an agent change; your open draft was kept. ${String(error)}`,
            );
          }
          continue;
        }
        const result = reconcileDocsAfterExternalWrite(
          getState().editorDocs ?? [],
          path,
          diskText,
        );
        if (result.reloaded) {
          setState({ editorDocs: result.docs });
        } else if (result.conflict && !warnedDocPaths.current.has(path)) {
          warnedDocPaths.current.add(path);
          toast(
            "warn",
            `${path} changed on disk by the agent. Your unsaved draft was kept; saving will show the new baseline for review.`,
          );
        }
      }
    })();
  }, [s.agentChangeTick, s.activeWorkspacePath]);

  const requestCloseDocument = (path: string) => {
    const doc = docs.find((d) => d.path === path);
    if (!doc) return;
    if (!docDirty(doc)) {
      const left = docs.filter((d) => d.path !== path);
      const nextActive = closeDocument(docs, path);
      setDocs(left, nextActive);
      setConfirmClose(null);
      return;
    }
    setConfirmClose(path);
  };

  // Escape closes the preview first and only then tabs (with dirty
  // protection). When a review (diffEntry) or the settings modal owns the
  // screen, tab handling stands down entirely.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Another screen (review diff / settings) owns the keyboard right now.
      if (s.diffEntry || s.settingsOpen) return;
      if (event.key === "Escape" && !confirmClose) {
        if (menu) { event.preventDefault(); setMenu(null); return; }
        if (previewPath) { event.preventDefault(); clearPreview(); }
        else if (editorOpen && active) { event.preventDefault(); requestCloseDocument(active); }
        return;
      }
      const action = tabKeyAction(event, editorOpen && !confirmClose);
      if (!action) return;
      event.preventDefault();
      if (action === "close-active") requestCloseDocument(active);
      else setDocs(docs, cycleActive(docs, active, action === "cycle-next" ? "next" : "prev"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [docs, active, editorOpen, previewPath, confirmClose, menu, s.diffEntry, s.settingsOpen]);

  const workspace = s.activeWorkspacePath;

  /** Single click: select the row and preview a file inline (never a modal). */
  const selectNode = (node: TreeNode) => {
    setFocusPath(node.path);
    setSelectedPath(node.path);
    setMenu(null);
    if (node.dir || !workspace) return;
    // An open document is already available in the editor pane; selecting it
    // shows that tab instead of a separate preview of the same path.
    if (activateOpenDoc(node.path)) return;
    previewCtl.select(workspace, node.path);
  };

  /** Double click / Enter: open (or focus) the file in an editor tab. */
  const openInEditor = async (path: string) => {
    if (!path) return;
    setSelectedPath(path);
    if (activateOpenDoc(path)) return;
    const known = previewCtl.peek(workspace ?? "", path);
    if (known?.has_more) {
      toast("warn", `${path} is large; it previews in pages. Open it from the preview pane after paging to the part you need.`);
      return;
    }
    if (openingEditor) return;
    setOpeningEditor(true);
    setLoadingPath(path);
    try {
      const exact = await cmd.fileText(path);
      // Refuses to exceed MAX_DOCS; the error surfaces as a normal toast.
      const opened = openDocument(getState().editorDocs ?? [], path, exact.content);
      setState({ editorWorkspaceTag: workspace });
      setDocs(opened.docs, opened.active);
      clearPreview();
    } catch (error) {
      toast("error", String(error));
    } finally {
      setOpeningEditor(false);
      setLoadingPath(null);
    }
  };

  const copyPath = async (path: string, absolute: boolean) => {
    const text = absolute ? absoluteWorkspacePath(workspace ?? "", path) : path;
    try {
      await navigator.clipboard.writeText(text);
      toast("info", `Copied ${absolute ? "absolute" : "relative"} path: ${text}`);
    } catch (error) {
      toast("warn", `Could not copy the path: ${String(error)}`);
    }
    setMenu(null);
  };

  // Sharing a selected-but-unopened file reads DISK text and labels the
  // attachment "on-disk"; an open document keeps sharing its current draft.
  const shareFileFromDisk = async (path: string) => {
    if (!workspace) return;
    try {
      const text = await cmd.fileText(path);
      const built = buildEditorContext({
        workspace,
        path,
        draft: String(text?.content ?? ""),
        original: String(text?.content ?? ""),
        origin: "disk",
      });
      if ("error" in built) { toast("warn", built.error); return; }
      const result = addEditorContext(getState().editorContexts ?? [], built.item);
      if (result.error) { toast("warn", result.error); return; }
      setState({ editorContexts: result.items, view: "chat" });
      toast(
        "info",
        `${result.replaced ? "Updated" : "Added"} ${built.item.path} to this prompt's editor context (on disk). Review or remove it before sending.`,
      );
    } catch (error) {
      toast("error", `Could not read ${path}: ${String(error)}`);
    }
  };

  // CP9: explicit sharing of the CURRENT draft (never a disk re-read), with a
  // live selection becoming a bounded line range when one exists.
  const shareEditorWithAgent = async () => {
    if (!activeDoc || !workspace) return;
    try {
      const root = findEditorRoot(activeDoc.path, document);
      const selection = await captureEditorSelection(activeDoc.path, activeDoc.draft, root);
      const built = buildEditorContext({
        workspace,
        path: activeDoc.path,
        draft: activeDoc.draft,
        original: activeDoc.original,
        selection,
        origin: "draft",
      });
      if ("error" in built) { toast("warn", built.error); return; }
      const result = addEditorContext(getState().editorContexts ?? [], built.item);
      if (result.error) { toast("warn", result.error); return; }
      setState({ editorContexts: result.items, view: "chat" });
      toast(
        "info",
        `${result.replaced ? "Updated" : "Added"} ${built.item.path} to this prompt's editor context. Review or remove it before sending.`,
      );
    } catch (error) {
      toast("error", `Could not read the editor selection: ${String(error)}`);
    }
  };

  /** Header share: draft when the selection is an open document, else disk. */
  const shareSelection = async () => {
    if (selectedPath && docs.some((d) => d.path === selectedPath)) {
      setDocs(docs, selectedPath);
      await shareEditorWithAgent();
      return;
    }
    if (selectedPath) { await shareFileFromDisk(selectedPath); return; }
    if (activeDoc) await shareEditorWithAgent();
  };

  const saveDoc = (doc: DocRec) => {
    if (!doc) return;
    const blocked = editBlockReason(doc.original, doc.draft);
    if (blocked) { toast("error", blocked); return; }
    const path = doc.path;
    const next = doc.draft;
    // Checkpoint 4: the review carries the Save conflict-reload path. On an
    // "apply" the backend re-verifies the on-disk baseline (optimistic
    // concurrency, checked inside ui_file_save); a conflict keeps the review
    // open, rebases the diff onto the newest disk contents and keeps the
    // unsaved draft for a fresh review.
    const applyChange = async () => {
      // The baseline must be the document's CURRENT diff base: after a conflict
      // rebase, re-applying validates against the reloaded on-disk contents.
      const current = (getState().editorDocs ?? []).find((d) => d.path === path);
      try {
        await cmd.fileSave(path, next, current?.original ?? doc.original);
      } catch (error) {
        // Invoke rejections arrive as plain strings; stubs and other layers
        // may hand over an Error object. Match the marker in either shape.
        const text = error instanceof Error ? error.message : String(error);
        if (!text.startsWith(SAVE_CONFLICT_PREFIX)) throw error;
        // Conflict recovery: reload the latest disk bytes, rebase THIS
        // document's diff base onto them (the draft survives untouched) and
        // rebuild the review against the fresh baseline.
        const latest = await cmd.fileText(path);
        const rebased = docsAfterConflictRebase(getState().editorDocs ?? [], path, String(latest?.content ?? ""));
        const entry = getState().diffEntry;
        const freshPreview = entry?.preview
          ? { ...entry.preview, old: String(latest?.content ?? ""), new: next, apply: entry.preview.apply }
          : entry?.preview;
        setState({ editorDocs: rebased, ...(entry?.preview ? { diffEntry: { ...entry, preview: freshPreview } } : {}) });
        throw new Error(
          `${path} changed on disk since review started. The diff now shows your draft against the latest file — check it and apply again.`,
        );
      }
      const updated = docsAfterSave(getState().editorDocs ?? [], path, next);
      setState({ editorDocs: updated });
      // The saved bytes are now the truth: drop the cached preview for this
      // path (and refresh it if it is the file on screen).
      previewCtl.invalidate(getState().activeWorkspacePath ?? "", path);
      toast("info", `Saved ${path}`);
    };
    // The diff is the approval gate: ui_file_save runs only from Apply below.
    // The closure keeps (path, captured draft) together, so the result is
    // routed to exactly this document no matter which tab is active later.
    setState({
      diffEntry: {
        taskId: "",
        entryId: -1,
        preview: {
          path,
          old: doc.original,
          new: next,
          apply: applyChange,
        },
      },
    });
  };

  const toggle = async (node: TreeNode) => {
    if (!node.dir) {
      await openInEditor(node.path);
      return;
    }
    // Load children lazily on first expand; a failed attempt leaves
    // `children` undefined (with the error kept on the row), so the next click
    // is a retry instead of a dead end.
    if (node.children === undefined) {
      if (loadingDirs.includes(node.path)) return;
      const generation = treeGen.current;
      setLoadingDirs((prev) => [...prev, node.path]);
      try {
        const listing = await cmd.tree(node.path);
        if (generation !== treeGen.current) return; // workspace switch/refresh won
        setRoots((prev) => applyListing(prev, listing));
      } catch (error) {
        if (generation !== treeGen.current) return;
        setRoots((prev) => setNodeError(prev, node.path, String(error)));
        toast("error", String(error));
      } finally {
        setLoadingDirs((prev) => prev.filter((path) => path !== node.path));
      }
      return;
    }
    setRoots((prev) => replaceNode(prev, node.path, (current) => ({ ...current, open: !current.open, error: undefined })));
  };

  const focusRow = (path: string) => {
    setFocusPath(path);
    rowRefs.current.get(path)?.focus();
  };

  // Roving-tabindex tree keyboard model (CP5) with the 3Q-2b split:
  // arrows move selection, Right expands or enters, Left collapses or moves to
  // the parent, Enter opens in the editor, Space toggles the inline preview.
  const onTreeKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    const rowElement = target?.closest?.(".ft-row") as HTMLElement | null;
    if (!rowElement) return;
    const rows = visibleRows(roots);
    // Use the focused row itself, not the focusPath state: a key press can
    // arrive in the same tick as focus moved (before that state re-renders),
    // and acting on the previously focused row would expand/activate the
    // wrong node.
    const current = rowElement.getAttribute("data-path") || focusPath || rows[0]?.node.path || "";
    if (event.key === "F10" && event.shiftKey) {
      event.preventDefault();
      const rect = rowElement.getBoundingClientRect();
      const node = rows.find((row) => row.node.path === current)?.node;
      if (node && !node.dir) openMenu(node.path, rect.left + 12, rect.bottom);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      const node = rows.find((row) => row.node.path === current)?.node;
      if (!node) return;
      event.preventDefault();
      setSelectedPath(node.path);
      if (node.dir) { void toggle(node); return; }
      if (event.key === "Enter") void openInEditor(node.path);
      else if (previewPath === node.path) clearPreview();
      else if (workspace) previewCtl.select(workspace, node.path);
      return;
    }
    const action = treeKeyAction(rows, current, event.key);
    if (!action) return;
    event.preventDefault();
    if (action.kind === "focus") {
      setSelectedPath(action.path);
      const node = rows.find((row) => row.node.path === action.path)?.node;
      if (node && !node.dir && workspace) previewCtl.select(workspace, node.path);
      focusRow(action.path);
      return;
    }
    if (action.kind === "collapse") {
      setRoots((prev) => replaceNode(prev, action.node.path, (node) => ({ ...node, open: false })));
      return;
    }
    if (action.kind === "expand") { setSelectedPath(action.node.path); void toggle(action.node); return; }
    setSelectedPath(action.node.path);
    void toggle(action.node);
  };

  const openMenu = (path: string, x: number, y: number) => {
    setSelectedPath(path);
    setMenu({ path, x, y });
  };

  const runMenuAction = async (action: FileMenuAction) => {
    const path = menu?.path;
    if (!path) return;
    setMenu(null);
    if (action === "open") { await openInEditor(path); return; }
    if (action === "preview") {
      if (previewPath === path) clearPreview();
      else if (workspace) previewCtl.select(workspace, path);
      return;
    }
    if (action === "copy-relative") { await copyPath(path, false); return; }
    if (action === "copy-absolute") { await copyPath(path, true); return; }
    if (action === "share") { await shareFileFromDisk(path); return; }
  };

  // Keep exactly one tab stop even when a refresh removes the focused path:
  // a roving tabindex that points at a vanished row would strand keyboard
  // users outside the tree.
  const rowsForFocus = visibleRows(roots);
  const focusableRowPath = rowsForFocus.some((row) => row.node.path === focusPath)
    ? focusPath
    : (rowsForFocus[0]?.node.path ?? "");
  const menuItems = fileMenuItems();
  const previewShown = !!previewPath;

  const pane = previewShown
    ? <PreviewPane
        path={previewPath}
        preview={preview}
        loading={previewLoading}
        error={previewError}
        dirtyDraft={selectedDirty}
        onOpen={() => void openInEditor(previewPath)}
        onShare={() => void shareFileFromDisk(previewPath)}
        onCopy={() => void copyPath(previewPath, false)}
        onClose={clearPreview}
        onPaged={(offset) => {
          if (workspace) void previewCtl.load(workspace, previewPath, offset);
        }} />
    : null;

  return (
    <div class={`filetree file-workspace ${show ? "" : "collapsed"}`} ref={rootRef}>
      <div class="fw-explorer" style={`width: ${show ? paneWidth : 44}px`}>
        <div class="ft-head">
          <span>Files</span>
          <div class="ft-head-actions">
            <button class="ghost" title={
              selectedDoc
                ? `Share ${selectedPath} with the agent (current editor draft)`
                : selectedPath
                  ? `Share ${selectedPath} with the agent (on-disk contents)`
                  : "Share the active editor with the agent (selection, or whole file when nothing is selected)"
            }
              aria-label={selectedPath ? `Share ${selectedPath} with agent` : `Share ${active} with agent`}
              disabled={!selectedPath && !activeDoc}
              onClick={() => void shareSelection()}><Icon name="code" size={16} /></button>
            <button class="ghost" title={treeStatus === "loading" ? "Refreshing…" : "Refresh (keeps expanded folders)"}
              aria-label="Refresh file tree" aria-busy={treeStatus === "loading"}
              disabled={treeStatus === "loading" || !workspace}
              onClick={() => void refreshTree()}><Icon name="refresh" size={16} /></button>
            <button class="ghost" title={show ? "Collapse explorer" : "Expand explorer"} aria-label={show ? "Collapse file tree" : "Expand file tree"} onClick={() => setShow(!show)}><Icon name={show ? "chevron-left" : "chevron-right"} size={16} /></button>
          </div>
        </div>
        {show ? (
          <div class="ft-body" role="tree" aria-label="Workspace files" aria-busy={treeStatus === "loading" || undefined}
            onKeyDown={onTreeKeyDown}>
            {!workspace ? <div class="ft-empty">No workspace open</div> : null}
            {workspace && treeStatus === "loading" && roots.length === 0
              ? <div class="ft-empty" role="status" aria-busy="true">Loading workspace…</div> : null}
            {workspace && treeStatus === "ready" && roots.length === 0
              ? <div class="ft-empty">This workspace is empty</div> : null}
            {treeStatus === "error" && treeError ? (
              <div class="ft-error" role="alert">
                <span>{treeError}</span>
                <button class="ghost" onClick={() => void refreshTree()}>Retry</button>
              </div>
            ) : null}
            {rootMeta ? (() => {
              const notice = listingNotice(rootMeta);
              return notice ? <div class="ft-note" role="status">{notice}</div> : null;
            })() : null}
            {roots.map((n) => <NodeView key={n.path} node={n} depth={0} onToggle={toggle} loadingPath={loadingPath}
              loadingDirs={loadingDirs}
              focusablePath={focusableRowPath}
              onFocusPath={setFocusPath}
              onRowRef={(path, element) => { if (element) rowRefs.current.set(path, element); else rowRefs.current.delete(path); }}
              selectedPath={selectedPath}
              activeDocPath={active}
              previewPath={previewPath}
              dirtyPaths={dirtyPaths}
              onSelect={selectNode}
              onOpen={(path) => void openInEditor(path)}
              onMenu={openMenu}
              agentChanged={agentChanged} />)}
          </div>
        ) : null}
      </div>
      {show ? (
        <SplitPane width={paneWidth} bounds={bounds} label="Resize file explorer"
          defaultWidth={clampSplitWidth(SPLIT_DEFAULT_WIDTH, bounds)}
          onWidth={setExplorerWidth} onCommit={persistWidth} />
      ) : null}
      <section class="fw-editor" aria-label="File workspace">
        <div class="fw-editor-bar">
          <div class="fw-editor-title">
            {previewShown
              ? <span>{previewPath}{selectedDirty ? " · on disk (unsaved draft open in a tab)" : " · on disk"}</span>
              : editorOpen
                ? <span>{active}{docDirty(activeDoc!) ? " · unsaved draft" : " · saved"}</span>
                : <span>No file selected</span>}
          </div>
          <div class="file-preview-actions">
            {!previewShown && editorOpen && activeDoc ? (
              <>
                <button class="btn-yes" onClick={() => saveDoc(activeDoc)} disabled={!docDirty(activeDoc)}>Review &amp; save</button>
                <button class="btn-no" aria-label="Close all open documents"
                  title={`Close all ${docs.length} document${docs.length > 1 ? "s" : ""}${docs.some(docDirty) ? " — unsaved changes will be confirmed" : ""}`}
                  onClick={() => {
                    const firstDirty = docs.find(docDirty);
                    if (firstDirty) { setConfirmClose(firstDirty.path); return; }
                    // Clean close-all: unmounting disposes every view.
                    setState({ editorDocs: [], editorActivePath: "", editorWorkspaceTag: null });
                    clearPreview();
                  }}>Close all</button>
              </>
            ) : null}
          </div>
        </div>
        {editorOpen ? <Tabs ariaLabel="Open documents" active={active}
          items={docs.map((d) => ({
            id: d.path,
            label: docName(d.path),
            title: `${d.path}${docDirty(d) ? " — unsaved changes" : ""}`,
            dirty: docDirty(d),
          }))}
          onActivate={(p) => { setSelectedPath(p); activateOpenDoc(p); }}
          onClose={requestCloseDocument} /> : null}
        {pane}
        {editorOpen ? (
          <div class="doc-editors" style={previewShown ? "display:none" : "display:block"}>
            {docs.map((d) => <DocEditor key={d.path} doc={d} visible={!previewShown && d.path === active} />)}
          </div>
        ) : null}
        {!editorOpen && !previewShown ? (
          <EmptyState title="No file open">
            <p>Select a file to preview it · double-click or press Enter to open it in the editor.</p>
            <p class="fw-empty-hint">↑ ↓ move · → expand a folder · Space previews · Shift+F10 opens the file menu</p>
          </EmptyState>
        ) : null}
      </section>
      {menu ? <FileContextMenu x={menu.x} y={menu.y} items={menuItems}
        onPick={(action) => void runMenuAction(action)}
        onClose={() => setMenu(null)} /> : null}
      {confirmClose ? <CloseConfirm
        docs={docs} path={confirmClose}
        onCancel={() => setConfirmClose(null)}
        onDiscard={() => {
          const left = docs.filter((d) => d.path !== confirmClose);
          const nextActive = closeDocument(docs, confirmClose);
          setDocs(left, nextActive);
          setConfirmClose(null);
        }}
        onReview={() => { const d = docs.find((x) => x.path === confirmClose); if (d) saveDoc(d); setConfirmClose(null); }} /> : null}
    </div>
  );
}

/** Inline, read-only preview of the ON-DISK file. Replaces the old modal: it
 *  lives in the editor pane, so the explorer stays visible and selection is
 *  never hidden behind an overlay. The pane cannot write: it has no save path,
 *  and "Open in editor" is the only route into an editable document. */
function PreviewPane(props: {
  path: string;
  preview: FilePreview | null;
  loading: boolean;
  error: string | null;
  dirtyDraft: boolean;
  onOpen: () => void;
  onShare: () => void;
  onCopy: () => void;
  onClose: () => void;
  onPaged: (offset: number) => void;
}) {
  return (
    <div class="file-preview-pane" aria-label={`Preview of ${props.path}`}>
      <header class="file-preview-head">
        <div>
          <strong>{docName(props.path)}</strong>
          <small>
            {props.path}
            {props.preview ? ` · ${props.preview.size_bytes.toLocaleString()} bytes${props.preview.has_more ? " · paged" : " · whole file"}` : ""}
            {" · on disk"}
            {props.dirtyDraft ? " · an unsaved draft of this file is open in a tab" : ""}
          </small>
        </div>
        <div class="file-preview-actions">
          <button class="btn-yes" onClick={props.onOpen} disabled={props.loading || !props.preview}>Open in editor</button>
          <button class="btn-no" onClick={props.onShare} disabled={!props.preview}>Share with chat</button>
          <button class="ghost" onClick={props.onCopy} title="Copy the workspace-relative path">Copy path</button>
          <button class="ghost icon-button" aria-label="Close preview" onClick={props.onClose}><Icon name="close" size={16} /></button>
        </div>
      </header>
      {props.loading ? <div class="file-preview-loading" role="status" aria-busy="true">Loading preview…</div> : null}
      {!props.loading && props.preview ? <PlainPreview preview={props.preview} previewError={props.error} onPaged={props.onPaged} /> : null}
      {!props.loading && !props.preview && props.error ? <p class="file-preview-error">{props.error}</p> : null}
    </div>
  );
}

function FileContextMenu(props: { x: number; y: number; items: ReturnType<typeof fileMenuItems>; onPick: (a: FileMenuAction) => void; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div class="ft-menu" role="menu" aria-label="File actions" tabIndex={-1} ref={ref}
      style={`left: ${props.x}px; top: ${props.y}px`}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key === "Escape") { event.preventDefault(); props.onClose(); return; }
        if (event.key === "Enter") { event.preventDefault(); props.onPick(props.items[index].id); return; }
        const next = menuIndexForKey(index, props.items.length, event.key);
        if (next === null) return;
        event.preventDefault();
        setIndex(next);
      }}>
      {props.items.map((item, position) => (
        <button key={item.id} role="menuitem" tabIndex={-1} class={position === index ? "ft-menu-active" : ""}
          onMouseEnter={() => setIndex(position)}
          onClick={() => props.onPick(item.id)}>{item.label}</button>
      ))}
    </div>
  );
}

/** One mounted editor per open document; only the active one is visible.
 * Unmounting a document's block destroys its view (clean disposal, no
 * orphans); switching tabs just toggles visibility, preserving the view's
 * own cursor/selection/scroll. A preview does NOT unmount these: it hides the
 * container, so every draft and every view state survives while browsing. */
function DocEditor(props: { doc: DocRec; visible: boolean }) {
  return (
    <div class="doc-editor" data-doc-path={props.doc.path} style={props.visible ? "display:block" : "display:none"} aria-hidden={props.visible ? undefined : "true"}>
      <EditorSlot path={props.doc.path} value={props.doc.draft} visible={props.visible}
        onInput={(text: string) => {
          setState((st) => ({ editorDocs: (st.editorDocs ?? []).map((d) => (d.path === props.doc.path ? { ...d, draft: text } : d)) }));
        }} />
      <footer class="file-preview-foot">
        <span>{editStatus(props.doc.original, props.doc.draft)} · saving writes after you review the diff</span>
      </footer>
    </div>
  );
}

function PlainPreview(props: { preview: FilePreview; previewError: string | null; onPaged: (offset: number) => void }) {
  const { preview, previewError, onPaged } = props;
  return <>
    <pre class="file-preview-content">{preview.content}</pre>
    {(preview.size_bytes > 30 * 1024 || preview.offset > 0 || preview.has_more) ? <footer class="file-preview-foot">
      <span>Showing up to {preview.line_limit} lines per page · content capped at 30 KB</span>
      <button class="btn-no" disabled={preview.offset === 0} onClick={() => onPaged(Math.max(0, preview.offset - preview.line_limit))}>Previous</button>
      <button class="btn-no" disabled={!preview.has_more} onClick={() => onPaged(preview.offset + preview.line_limit)}>Next</button>
    </footer> : null}
    {previewError ? <p class="file-preview-error">{previewError}</p> : null}
  </>;
}

/** Unsaved-close confirmation, in-app (shared modal markup — no
 * window.confirm). Cancel keeps editing, Review & save first opens the existing
 * diff gate, Discard is explicit. */
function CloseConfirm(props: { docs: DocRec[]; path: string; onCancel: () => void; onDiscard: () => void; onReview: () => void }) {
  const doc = props.docs.find((d) => d.path === props.path);
  if (!doc) return null;
  return (
    <div class="modal-backdrop" role="presentation">
      <section class="modal editor-close-confirm" role="dialog" aria-modal="true" aria-labelledby="ecc-title" onClick={(e) => e.stopPropagation()}>
        <div class="modal-head"><h2 id="ecc-title">Discard unsaved changes?</h2></div>
        <p>{docName(doc.path)} ({doc.path}) has changes that were not reviewed or saved. Closing the tab discards the draft; the file on disk stays untouched.</p>
        <div class="diff-actions">
          <button class="btn-no" onClick={props.onCancel}>Cancel</button>
          <button class="btn-no" onClick={props.onReview} title="Open the review diff for this document">Review &amp; save first</button>
          <button class="ghost danger" onClick={props.onDiscard}>Discard changes</button>
        </div>
      </section>
    </div>
  );
}

/**
 * Lazy editor slot — one per document; the component stays mounted while the
 * tab is open (even when hidden). CodeMirror + language packs load in their
 * own chunk(s) on first use. The plain textarea stays as the fallback if the
 * chunk ever fails to load; it remains fully subject to the same rules
 * (value comes from the caller's draft; saving flows through the review
 * gate), so no alternative save route exists either way.
 */
function EditorSlot(props: { path: string; value: string; visible: boolean; onInput: (text: string) => void }) {
  const [EditorComponent, setEditorComponent] = useState<any>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    import("./NativeEditor").then((m: { NativeEditor: any }) => {
      if (alive) setEditorComponent(() => m.NativeEditor);
    }).catch(() => {
      if (alive) setFailed(true);
    });
    return () => { alive = false; };
  }, []);
  if (EditorComponent) return <EditorComponent path={props.path} value={props.value} visible={props.visible} onInput={props.onInput} />;
  if (failed) return (
    <textarea class="file-editor" aria-label={`Editing ${props.path}`} spellcheck={false} value={props.value}
      onInput={(event) => props.onInput((event.currentTarget as HTMLTextAreaElement).value)} />
  );
  return (
    <div class="file-editor-host file-editor-loading" aria-busy="true" aria-label={`Loading editor for ${props.path}`}>
      <span>Loading editor…</span>
    </div>
  );
}

function NodeView(props: {
  node: TreeNode;
  depth: number;
  onToggle: (n: TreeNode) => void;
  loadingPath: string | null;
  loadingDirs: string[];
  selectedPath: string;
  activeDocPath: string;
  previewPath: string;
  dirtyPaths: string[];
  focusablePath: string;
  onFocusPath: (path: string) => void;
  onRowRef: (path: string, element: HTMLDivElement | null) => void;
  onSelect: (n: TreeNode) => void;
  onOpen: (path: string) => void;
  onMenu: (path: string, x: number, y: number) => void;
  agentChanged: Record<string, { title: string; at: number }>;
}) {
  const { node, depth, onToggle, loadingPath, loadingDirs, selectedPath, activeDocPath, previewPath, dirtyPaths, focusablePath, onFocusPath, onRowRef, onSelect, onOpen, onMenu, agentChanged } = props;
  const open = !!node.open && !!node.children;
  const dirty = dirtyPaths.includes(node.path);
  const agent = agentChanged[node.path];
  const busy = loadingDirs.includes(node.path);
  const selected = selectedPath === node.path;
  const isActiveDoc = !!activeDocPath && activeDocPath === node.path;
  const isPreviewed = !!previewPath && previewPath === node.path;
  const notice = open ? listingNotice({ truncated: !!node.truncated, limit: node.limit ?? 0, unreadable: node.unreadable ?? 0 }) : null;
  return (
    <>
      <div class={`ft-row ${selected ? "ft-row-selected" : ""} ${isActiveDoc ? "ft-row-open" : ""} ${isPreviewed ? "ft-row-preview" : ""} ${dirty ? "ft-row-dirty" : ""} ${agent ? "ft-row-agent" : ""}`}
        role="treeitem" aria-level={depth + 1} data-path={node.path}
        aria-expanded={node.dir ? open : undefined}
        aria-selected={selected ? true : undefined}
        aria-current={isActiveDoc ? "true" : undefined}
        aria-busy={busy || undefined}
        tabIndex={focusablePath === node.path ? 0 : -1}
        ref={(element: HTMLDivElement | null) => onRowRef(node.path, element)}
        aria-label={node.dir ? `${open ? "Collapse" : "Expand"} ${node.name}` : `${node.path}${dirty ? " (unsaved changes)" : ""}${agent ? " (changed by the agent)" : ""}`}
        style={`padding-left: ${depth * 14 + 6}px`}
        onFocus={() => onFocusPath(node.path)}
        onClick={() => { onFocusPath(node.path); if (node.dir) void onToggle(node); else onSelect(node); }}
        onDblClick={() => { if (!node.dir) onOpen(node.path); }}
        onContextMenu={(event: MouseEvent) => {
          if (node.dir) return; // only file actions exist
          event.preventDefault();
          onMenu(node.path, event.clientX, event.clientY);
        }}>
        <span class={`ft-caret ${open ? "ft-caret-open" : ""}`}>{node.dir ? <Icon name="chevron-right" size={13} /> : null}</span>
        <span class={`ft-name ${node.dir ? "ft-dir" : "ft-file"}`}>{node.name}</span>
        {dirty ? <span class="ft-dirty-dot" title="Unsaved changes">•</span> : null}
        {agent ? <span class="ft-agent-dot" title={agent.title} aria-label={agent.title}>◆</span> : null}
        {busy ? <small>Loading…</small> : loadingPath === node.path ? <small>Opening…</small> : null}
        {node.error ? <small class="ft-row-error" title={node.error}>Couldn’t load — retry</small> : null}
      </div>
      {open && node.children ? node.children.map((c) => <NodeView key={c.path} node={c} depth={depth + 1} onToggle={onToggle} loadingPath={loadingPath}
        loadingDirs={loadingDirs} selectedPath={selectedPath} activeDocPath={activeDocPath} previewPath={previewPath}
        dirtyPaths={dirtyPaths} focusablePath={focusablePath} onFocusPath={onFocusPath} onRowRef={onRowRef}
        onSelect={onSelect} onOpen={onOpen} onMenu={onMenu} agentChanged={agentChanged} />) : null}
      {open && node.children && notice ? (
        <div class="ft-note" role="status" style={`padding-left: ${(depth + 1) * 14 + 6}px`}>{notice}</div>
      ) : null}
    </>
  );
}

export default FileTree;
