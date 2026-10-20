export const THEME_TOKENS = [
  "--theme-bg",
  "--theme-surface",
  "--theme-raised",
  "--theme-text",
  "--theme-muted",
  "--theme-border",
  "--theme-hover",
  "--theme-accent",
] as const;

export type ThemeToken = typeof THEME_TOKENS[number];
export type ThemePalette = Partial<Record<ThemeToken, string>>;

export const DEFAULT_CUSTOM_THEME = `{
  "--theme-bg": "#101116",
  "--theme-surface": "#191b22",
  "--theme-raised": "#232630",
  "--theme-text": "#f1f2f7",
  "--theme-muted": "#b1b5c2",
  "--theme-border": "#3a3e4b",
  "--theme-hover": "#303441",
  "--theme-accent": "#8290ff"
}`;

export function parseCustomTheme(source: string): { colors: ThemePalette; error?: string; format: "json" | "css" } {
  const text = source.trim();
  const isJson = text.startsWith("{");
  let values: Record<string, unknown>;
  if (isJson) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { colors: {}, error: "Theme JSON must be an object of color tokens.", format: "json" };
      }
      values = parsed as Record<string, unknown>;
    } catch (error) {
      return { colors: {}, error: `Invalid JSON: ${String(error)}`, format: "json" };
    }
  } else {
    let declarations = text.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (declarations.startsWith(":root")) {
      const match = declarations.match(/^:root\s*\{([\s\S]*)\}\s*$/);
      if (!match) return { colors: {}, error: "CSS theme files may contain only a :root { ... } token block.", format: "css" };
      declarations = match[1];
    }
    values = {};
    for (const declaration of declarations.split(";")) {
      const item = declaration.trim();
      if (!item) continue;
      const match = item.match(/^(--theme-[a-z-]+)\s*:\s*(.+)$/);
      if (!match) return { colors: {}, error: "Use only --theme-* color declarations in the CSS theme file.", format: "css" };
      values[match[1]] = match[2].trim();
    }
  }

  const allowed = new Set<string>(THEME_TOKENS);
  const colors: ThemePalette = {};
  for (const [token, value] of Object.entries(values)) {
    if (!allowed.has(token)) return { colors: {}, error: `Unsupported theme token: ${token}`, format: isJson ? "json" : "css" };
    if (typeof value !== "string" || !isSafeColor(value)) {
      return { colors: {}, error: `${token} must be a CSS color value (for example #101116 or rgb(16 17 22)).`, format: isJson ? "json" : "css" };
    }
    colors[token as ThemeToken] = value.trim();
  }
  if (!Object.keys(colors).length) return { colors, error: "Add at least one supported color token.", format: isJson ? "json" : "css" };
  return { colors, format: isJson ? "json" : "css" };
}

function isSafeColor(value: string): boolean {
  const color = value.trim();
  if (!color || /[;{}]|url\s*\(|var\s*\(|expression\s*\(/i.test(color)) return false;
  if (typeof CSS !== "undefined" && CSS.supports("color", color)) return true;
  return /^#[0-9a-f]{3,8}$/i.test(color)
    || /^(rgb|rgba|hsl|hsla)\([\d\s.,%/+-]+\)$/i.test(color)
    || /^(black|white|transparent|currentcolor|[a-z]{1,20})$/i.test(color);
}
