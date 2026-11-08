// Phase 3Q-2a — class mappings for the shared UI primitives.
// Pure on purpose: the visual contract is unit-tested here instead of being
// inferred from rendered markup, and the components stay trivial wrappers.
//
// The primitives deliberately reuse the class names the app already ships
// (.btn-yes/.btn-no/.ghost/.link/.chip/.panel) so adopting them is a
// markup-neutral change and 3Q-2a cannot move any screen's geometry.

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "link";

const BUTTON_CLASS: Record<ButtonVariant, string> = {
  primary: "btn-yes",
  secondary: "btn-no",
  ghost: "ghost",
  danger: "ghost danger",
  link: "link",
};

function merge(base: string, extra?: string): string {
  return extra ? `${base} ${extra}` : base;
}

/** Class list for a Button. Unknown variants fall back to `ghost`, never to
 *  the primary treatment (a wrong variant must not look like a commit). */
export function buttonClass(variant: ButtonVariant = "ghost", extra?: string): string {
  return merge(BUTTON_CLASS[variant] ?? BUTTON_CLASS.ghost, extra);
}

/** Every IconButton is a ghost icon button; the accessible name is required by
 *  the component's types, so there is no class-level variant here. */
export function iconButtonClass(extra?: string): string {
  return merge("ghost icon-button", extra);
}

export type PanelLevel = 0 | 1 | 2;

/** One background per region: 0 = transparent (already on a surface),
 *  1 = panel surface, 2 = raised content surface. */
export function panelClass(level: PanelLevel = 1, extra?: string): string {
  const safe: PanelLevel = level === 0 || level === 1 || level === 2 ? level : 1;
  return merge(`panel panel-${safe}`, extra);
}

export type TabState = { active: boolean; dirty?: boolean };

/** Tab strip container. Maps to the strip the editor already ships, so
 *  extracting `Tabs` from FileTree changed no class name and no geometry. */
export function tabBarClass(extra?: string): string {
  return merge("editor-tabs", extra);
}

/** One tab. Active/idle and the dirty marker are mutually independent, exactly
 *  as the original inline markup had them. */
export function tabClass(state: TabState, extra?: string): string {
  const base = `editor-tab ${state.active ? "editor-tab-active" : "editor-tab-idle"}`;
  return merge(state.dirty ? `${base} editor-tab-dirty` : base, extra);
}

export type ChipTone = "ok" | "warn" | "danger" | "muted";

export function statusChipClass(tone: ChipTone = "muted", extra?: string): string {
  const safe = tone === "ok" || tone === "warn" || tone === "danger" ? tone : "muted";
  return merge(`chip chip-${safe}`, extra);
}
