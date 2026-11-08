// Phase 3Q-2b — splitter arithmetic: bounds, clamping, drag, keyboard and
// untrusted persisted values. Pure module (no DOM).
import test from "node:test";
import assert from "node:assert/strict";
import {
  SPLIT_DEFAULT_WIDTH, SPLIT_MIN_WIDTH, SPLIT_MAX_WIDTH, SPLIT_STEP, SPLIT_PAGE_STEP,
  EDITOR_MIN_WIDTH, splitBounds, clampSplitWidth, normalizeStoredSplitWidth,
  splitWidthForDrag, splitWidthForKey,
} from "../src/splitPane.ts";

test("bounds keep both panes usable on a normal desktop window", () => {
  const bounds = splitBounds(1440);
  assert.equal(bounds.min, SPLIT_MIN_WIDTH);
  assert.equal(bounds.max, SPLIT_MAX_WIDTH);
  assert.ok(bounds.max * 3 <= 1440, "the editor keeps the majority of the workspace");
});

test("a narrow window caps the explorer so the editor keeps its minimum", () => {
  const bounds = splitBounds(SPLIT_MIN_WIDTH + EDITOR_MIN_WIDTH + 20);
  assert.equal(bounds.max, SPLIT_MIN_WIDTH + 20);
  assert.ok(SPLIT_MIN_WIDTH + 20 >= SPLIT_MIN_WIDTH);
});

test("the editor minimum wins even when the window cannot honour both minima", () => {
  const bounds = splitBounds(400);
  assert.equal(bounds.max, SPLIT_MIN_WIDTH, "max never drops below min");
  assert.equal(clampSplitWidth(480, bounds), SPLIT_MIN_WIDTH);
});

test("clamping rounds, bounds and rejects nonsense", () => {
  const bounds = { min: 220, max: 480 };
  assert.equal(clampSplitWidth(300.6, bounds), 301);
  assert.equal(clampSplitWidth(50, bounds), 220);
  assert.equal(clampSplitWidth(9999, bounds), 480);
  assert.equal(clampSplitWidth(Number.NaN, bounds), SPLIT_DEFAULT_WIDTH);
  assert.equal(clampSplitWidth("300", bounds), SPLIT_DEFAULT_WIDTH, "a string is not a width");
});

test("a persisted width from another window or build is normalized, not trusted", () => {
  assert.equal(normalizeStoredSplitWidth(9999), SPLIT_MAX_WIDTH);
  assert.equal(normalizeStoredSplitWidth(10), SPLIT_MIN_WIDTH);
  assert.equal(normalizeStoredSplitWidth(undefined), SPLIT_DEFAULT_WIDTH);
  assert.equal(normalizeStoredSplitWidth(null), SPLIT_DEFAULT_WIDTH);
  assert.equal(normalizeStoredSplitWidth(Infinity), SPLIT_DEFAULT_WIDTH);
  assert.equal(normalizeStoredSplitWidth(312), 312);
});

test("dragging follows the pointer and stays inside the bounds", () => {
  const bounds = { min: 220, max: 480 };
  assert.equal(splitWidthForDrag(300, 500, 540, bounds), 340);
  assert.equal(splitWidthForDrag(300, 500, 480, bounds), 280);
  assert.equal(splitWidthForDrag(300, 500, 900, bounds), 480, "a long drag stops at the maximum");
  assert.equal(splitWidthForDrag(300, 500, 0, bounds), 220, "and at the minimum in the other direction");
});

test("keyboard resizing is small-step, paged and absolute", () => {
  const bounds = { min: 220, max: 480 };
  assert.equal(splitWidthForKey("ArrowRight", 300, bounds), 300 + SPLIT_STEP);
  assert.equal(splitWidthForKey("ArrowLeft", 300, bounds), 300 - SPLIT_STEP);
  assert.equal(splitWidthForKey("PageUp", 300, bounds), 300 + SPLIT_PAGE_STEP);
  assert.equal(splitWidthForKey("PageDown", 300, bounds), 300 - SPLIT_PAGE_STEP);
  assert.equal(splitWidthForKey("Home", 300, bounds), 220);
  assert.equal(splitWidthForKey("End", 300, bounds), 480);
});

test("keys the separator does not own are left to the page", () => {
  const bounds = { min: 220, max: 480 };
  for (const key of ["Tab", "Enter", "ArrowUp", "ArrowDown", "a", "Escape"]) {
    assert.equal(splitWidthForKey(key, 300, bounds), null, `${key} is not a resize key`);
  }
});

test("horizontal arrow keys cannot invert or overflow the explorer", () => {
  const bounds = { min: 220, max: 480 };
  let width = 224;
  for (let i = 0; i < 10; i += 1) width = splitWidthForKey("ArrowLeft", width, bounds);
  assert.equal(width, 220);
  for (let i = 0; i < 40; i += 1) width = splitWidthForKey("ArrowRight", width, bounds);
  assert.equal(width, 480);
});
