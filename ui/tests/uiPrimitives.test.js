// Phase 3Q-2a: the primitives' class contract and legacy theme compatibility.
// Pure modules only — the visual result is verified by the theme captures.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { transformSync } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

function load(relative) {
  const source = readFileSync(join(here, "..", "src", relative), "utf8");
  const { code } = transformSync(source, { loader: "ts", format: "cjs" });
  const mod = { exports: {} };
  new Function("module", "exports", code)(mod, mod.exports);
  return mod.exports;
}

const { buttonClass, iconButtonClass, panelClass, statusChipClass, tabBarClass, tabClass } = load("uiPrimitives.ts");
const { parseCustomTheme, THEME_TOKENS } = load("theme.ts");

test("primary is the filled class and secondary is the chromed class", () => {
  assert.equal(buttonClass("primary"), "btn-yes");
  assert.equal(buttonClass("secondary"), "btn-no");
});

test("every variant maps to an existing class family", () => {
  assert.equal(buttonClass("ghost"), "ghost");
  assert.equal(buttonClass("danger"), "ghost danger");
  assert.equal(buttonClass("link"), "link");
});

test("an unknown variant never looks like a commit", () => {
  assert.equal(buttonClass("primarry"), "ghost");
  assert.equal(buttonClass(undefined), "ghost");
});

test("extra classes are appended once and keep their order", () => {
  assert.equal(buttonClass("primary", "wide"), "btn-yes wide");
  assert.equal(buttonClass("primary", ""), "btn-yes");
});

test("icon buttons always carry the ghost icon-button pair", () => {
  assert.equal(iconButtonClass(), "ghost icon-button");
  assert.equal(iconButtonClass("small"), "ghost icon-button small");
});

test("panel levels are clamped to a real surface", () => {
  assert.equal(panelClass(0), "panel panel-0");
  assert.equal(panelClass(2, "x"), "panel panel-2 x");
  assert.equal(panelClass(7), "panel panel-1");
});

test("chip tones are clamped to a semantic tone", () => {
  assert.equal(statusChipClass("ok"), "chip chip-ok");
  assert.equal(statusChipClass("danger", "z"), "chip chip-danger z");
  assert.equal(statusChipClass("purple"), "chip chip-muted");
});

test("a legacy custom theme (only the eight original tokens) still loads", () => {
  const legacy = JSON.stringify({
    "--theme-bg": "#101116",
    "--theme-surface": "#191b22",
    "--theme-raised": "#232630",
    "--theme-text": "#f1f2f7",
    "--theme-muted": "#b1b5c2",
    "--theme-border": "#3a3e4b",
    "--theme-hover": "#303441",
    "--theme-accent": "#8290ff",
  });
  const parsed = parseCustomTheme(legacy);
  assert.equal(parsed.error, undefined);
  assert.equal(Object.keys(parsed.colors).length, THEME_TOKENS.length);
  assert.equal(parsed.format, "json");
});

test("a partial legacy theme is still accepted", () => {
  const parsed = parseCustomTheme('{ "--theme-bg": "#000", "--theme-text": "#fff" }');
  assert.equal(parsed.error, undefined);
  assert.deepEqual(Object.keys(parsed.colors).sort(), ["--theme-bg", "--theme-text"]);
});

test("unknown token names are still rejected, so 3Q-2a adds no theme surface", () => {
  const parsed = parseCustomTheme('{ "--surface-1": "#000" }');
  assert.match(parsed.error, /Unsupported theme token: --surface-1/);
});

test("CSS themes keep the same rules", () => {
  const parsed = parseCustomTheme(":root { --theme-accent: #5966d8; }");
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.format, "css");
  assert.equal(parsed.colors["--theme-accent"], "#5966d8");
});

test("the stylesheet defines the primary button rule that was missing", () => {
  const css = readFileSync(join(here, "..", "src", "styles.css"), "utf8");
  assert.match(css, /\n\.btn-yes \{/);
  // The primary treatment must actually fill, not merely colour text.
  const block = css.slice(css.indexOf("\n.btn-yes {"));
  assert.match(block.slice(0, 200), /background: var\(--accent\)/);
});

test("the preview header keeps its action row horizontal", () => {
  // 3Q-2b native acceptance caught this: `.file-preview-head > div` set
  // flex-direction: column (for the title block) and outranked
  // `.file-preview-actions`, so Open / Share / Copy / close stacked vertically
  // and squeezed the file heading. The title rule must exclude the action row.
  const css = readFileSync(join(here, "..", "src", "styles.css"), "utf8");
  assert.match(css, /\.file-preview-head > div:not\(\.file-preview-actions\) \{[^}]*flex-direction: column/);
  assert.doesNotMatch(css, /\n\.file-preview-head > div \{[^}]*flex-direction: column/);
  const actions = css.slice(css.indexOf("\n.file-preview-actions {"));
  assert.match(actions.slice(0, 160), /display: flex/);
});

test("tab classes match the strip the editor already shipped", () => {
  assert.equal(tabBarClass(), "editor-tabs");
  assert.equal(tabBarClass("x"), "editor-tabs x");
  assert.equal(tabClass({ active: true }), "editor-tab editor-tab-active");
  assert.equal(tabClass({ active: false }), "editor-tab editor-tab-idle");
  assert.equal(tabClass({ active: false, dirty: true }), "editor-tab editor-tab-idle editor-tab-dirty");
  assert.equal(tabClass({ active: true, dirty: true }, "y"), "editor-tab editor-tab-active editor-tab-dirty y");
});

test("the primary is not out-shouted by a light secondary in dark theme", () => {
  // Found while verifying the fix: `.btn-no` had a dark rule (~line 275) and a
  // LATER unconditional light rule (#f0eef6), so the light one won in both
  // themes and the "secondary" action rendered brighter than the primary.
  const css = readFileSync(join(here, "..", "src", "styles.css"), "utf8");
  const darkBlock = css.slice(css.indexOf('[data-theme="dark"] .btn-no {'));
  assert.ok(darkBlock.length, "a dark-theme .btn-no override must exist");
  assert.match(darkBlock.slice(0, 120), /background: #33343b/);
  assert.doesNotMatch(darkBlock.slice(0, 120), /#f0eef6/);
  // ...and it must stay colour-only, so screen geometry is unchanged.
  assert.doesNotMatch(darkBlock.slice(0, 160), /padding|border-radius|width|height/);
});

test("reduced motion is handled app-wide, not just for the easter egg", () => {
  const css = readFileSync(join(here, "..", "src", "styles.css"), "utf8");
  const media = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(media, /\*, \*::before, \*::after/);
  assert.match(media, /transition-duration: \.001ms/);
});
