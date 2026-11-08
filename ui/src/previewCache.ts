// Phase 3Q-2b — selection-driven file previews.
//
// The explorer now selects a file and shows it inline, which means previews are
// requested far more often than before (arrow-key browsing). This module owns
// the two rules that make that safe and cheap:
//
//   1. reads are DEBOUNCED (~120 ms) so holding an arrow key does not fire a
//      request per row;
//   2. results are CACHED per workspace+path for the session, and a cached
//      entry is only trusted until an event the app itself observed invalidates
//      it (save, verified agent write, explicit refresh, workspace switch).
//
// Staleness is handled with a monotonic sequence: a response whose sequence is
// no longer current (the user selected something else, or the workspace
// changed) is discarded instead of overwriting the newer selection. There is no
// polling and no filesystem watcher here.
//
// Pure on purpose: the read function, timers and listeners are injected, so the
// debounce/cache/staleness contract is unit-tested without Tauri or a DOM.

export interface PreviewData {
  path: string;
  content: string;
  offset: number;
  line_limit: number;
  size_bytes: number;
  has_more: boolean;
}

export interface PreviewState {
  workspace: string;
  path: string;
  data: PreviewData | null;
  error: string | null;
  loading: boolean;
}

export const PREVIEW_DEBOUNCE_MS = 120;

export type PreviewRead = (path: string, offset: number) => Promise<PreviewData>;

export interface PreviewControllerDeps {
  read: PreviewRead;
  debounceMs?: number;
  /** Injected so tests can drive time deterministically. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onState?: (state: PreviewState) => void;
}

export interface PreviewController {
  /** Debounced selection. `null` clears the preview without a read. */
  select(workspace: string | null, path: string | null): void;
  /** Immediate read for paging (no debounce); still sequence-checked. */
  load(workspace: string, path: string, offset: number): Promise<PreviewState>;
  /** Cached page for a path, if one exists and is still trusted. */
  peek(workspace: string, path: string): PreviewData | null;
  /** Drop one path from the cache (and re-read it if it is on screen). */
  invalidate(workspace: string, path: string): void;
  /** Drop everything: workspace switch, or an event whose scope is unknown. */
  invalidateAll(): void;
  /** Cancel a pending debounce (component unmount). */
  cancel(): void;
  current(): PreviewState | null;
}

function keyOf(workspace: string, path: string): string {
  return `${workspace}\u0000${path}`;
}

export function createPreviewController(deps: PreviewControllerDeps): PreviewController {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as any));
  const debounceMs = deps.debounceMs ?? PREVIEW_DEBOUNCE_MS;
  const cache = new Map<string, PreviewData>();
  let seq = 0;
  let timer: unknown = null;
  let wanted: { workspace: string; path: string } | null = null;
  let state: PreviewState | null = null;

  const emit = (next: PreviewState | null) => {
    state = next;
    if (next) deps.onState?.(next);
  };

  const cancelTimer = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const read = async (workspace: string, path: string, offset: number): Promise<PreviewState> => {
    const mine = ++seq;
    try {
      const data = await deps.read(path, offset);
      if (mine !== seq || !wanted || wanted.workspace !== workspace || wanted.path !== path) {
        // A newer selection (or a workspace switch) won: this result must not
        // replace what the user is looking at now.
        return { workspace, path, data: null, error: null, loading: false };
      }
      cache.set(keyOf(workspace, path), data);
      const next: PreviewState = { workspace, path, data, error: null, loading: false };
      emit(next);
      return next;
    } catch (error) {
      if (mine !== seq) return { workspace, path, data: null, error: null, loading: false };
      const next: PreviewState = { workspace, path, data: null, error: String(error), loading: false };
      emit(next);
      return next;
    }
  };

  const select = (workspace: string | null, path: string | null) => {
    cancelTimer();
    // Any pending/queued response for the previous selection is now stale.
    seq += 1;
    if (!workspace || !path) {
      wanted = null;
      emit(null);
      return;
    }
    wanted = { workspace, path };
    const cached = cache.get(keyOf(workspace, path));
    if (cached) {
      emit({ workspace, path, data: cached, error: null, loading: false });
      return;
    }
    emit({ workspace, path, data: null, error: null, loading: true });
    timer = setTimer(() => {
      timer = null;
      void read(workspace, path, 0);
    }, debounceMs);
  };

  return {
    select,
    async load(workspace, path, offset) {
      cancelTimer();
      wanted = { workspace, path };
      emit({ workspace, path, data: state?.path === path ? state.data : null, error: null, loading: true });
      return read(workspace, path, offset);
    },
    peek(workspace, path) {
      return cache.get(keyOf(workspace, path)) ?? null;
    },
    invalidate(workspace, path) {
      cache.delete(keyOf(workspace, path));
      // Re-read what is on screen so an invalidated preview never keeps showing
      // contents the app already knows are out of date.
      if (wanted && wanted.workspace === workspace && wanted.path === path) {
        select(workspace, path);
      }
    },
    invalidateAll() {
      cancelTimer();
      seq += 1;
      cache.clear();
      // A selection can be made in the same tick as an invalidation (opening a
      // document tags the workspace, which invalidates everything). Cancelling
      // its debounce without restarting it would strand the pane on
      // "Loading preview…" forever, with no read pending and no error to show,
      // so a still-pending selection is restarted here. A workspace switch calls
      // cancel()/select(null) first, which clears `wanted`, so no old-workspace
      // read is revived.
      const pending = wanted;
      if (pending && state?.loading) select(pending.workspace, pending.path);
    },
    cancel() {
      cancelTimer();
      seq += 1;
      wanted = null;
    },
    current() {
      return state;
    },
  };
}
