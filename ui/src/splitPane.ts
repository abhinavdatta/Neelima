// Phase 3Q-2b — split-pane arithmetic (pure).
//
// The explorer/editor boundary is a 4 px splitter that can be dragged or moved
// with the keyboard. Keeping the math here means the persistence, clamping and
// keyboard contract are unit-tested without a DOM, and the component stays a
// thin renderer.
//
// Bounds are chosen so neither pane can become unusable: the explorer never goes
// below 220 px (its header keeps two actions readable) and never above 480 px
// (the editor keeps the majority of the workspace). The editor additionally
// keeps at least EDITOR_MIN_WIDTH px, which caps the explorer on a narrow window.

export const SPLIT_DEFAULT_WIDTH = 272;
export const SPLIT_MIN_WIDTH = 220;
export const SPLIT_MAX_WIDTH = 480;
export const SPLIT_STEP = 16;
export const SPLIT_PAGE_STEP = 64;
export const EDITOR_MIN_WIDTH = 320;

export interface SplitBounds {
  min: number;
  max: number;
}

/** Effective bounds for a given container width. */
export function splitBounds(containerWidth: number): SplitBounds {
  const available = Number.isFinite(containerWidth) ? containerWidth : 0;
  const max = Math.max(SPLIT_MIN_WIDTH, Math.min(SPLIT_MAX_WIDTH, Math.floor(available - EDITOR_MIN_WIDTH)));
  return { min: SPLIT_MIN_WIDTH, max };
}

/** Clamp anything (a drag delta, a hand-edited setting) into usable bounds. */
export function clampSplitWidth(width: unknown, bounds: SplitBounds = { min: SPLIT_MIN_WIDTH, max: SPLIT_MAX_WIDTH }): number {
  const value = typeof width === "number" && Number.isFinite(width) ? width : SPLIT_DEFAULT_WIDTH;
  const min = bounds.min;
  const max = Math.max(min, bounds.max);
  return Math.round(Math.min(max, Math.max(min, value)));
}

/**
 * A persisted width is untrusted input: another window size, an older build, or
 * a hand-edited settings file can all carry a value outside today's bounds.
 * Invalid values fall back to the default instead of producing NaN in a style.
 */
export function normalizeStoredSplitWidth(value: unknown, fallback = SPLIT_DEFAULT_WIDTH): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return clampSplitWidth(value);
}

/** Width after a pointer drag. Drag right widens the explorer. */
export function splitWidthForDrag(startWidth: number, startX: number, clientX: number, bounds: SplitBounds): number {
  return clampSplitWidth(startWidth + (clientX - startX), bounds);
}

/** Keyboard resizing for a focused separator; null means "not our key". */
export function splitWidthForKey(key: string, current: number, bounds: SplitBounds): number | null {
  switch (key) {
    case "ArrowLeft":
      return clampSplitWidth(current - SPLIT_STEP, bounds);
    case "ArrowRight":
      return clampSplitWidth(current + SPLIT_STEP, bounds);
    case "PageUp":
      return clampSplitWidth(current + SPLIT_PAGE_STEP, bounds);
    case "PageDown":
      return clampSplitWidth(current - SPLIT_PAGE_STEP, bounds);
    case "Home":
      return clampSplitWidth(bounds.min, bounds);
    case "End":
      return clampSplitWidth(bounds.max, bounds);
    default:
      return null;
  }
}
