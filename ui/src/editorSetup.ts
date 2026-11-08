// Pure, framework-free CodeMirror 6 setup for the native editor.
// Kept separate from the Preact component so the pieces that decide behavior
// (language selection, extension assembly) are unit-testable without a DOM.
// The document itself is never loaded here; the editor always starts from the
// complete exact on-disk text delivered by ui_file_text.
import type { Extension } from "@codemirror/state";

/** Language ids the editor supports. `null` = plain text (no highlighting). */
export type EditorLanguageId =
  | "javascript"
  | "rust"
  | "python"
  | "json"
  | "html"
  | "css"
  | "markdown"
  | null;

/** Map a workspace-relative path to a language id by its extension. */
export function languageIdForFilename(path: string): EditorLanguageId {
  const name = path.split(/[\\/]/).pop() ?? path;
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"].includes(ext)) return "javascript";
  if (ext === "rs") return "rust";
  if (ext === "py") return "python";
  if (ext === "json") return "json";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "css" || ext === "scss") return "css";
  if (ext === "md" || ext === "markdown" || ext === "mdx") return "markdown";
  return null;
}

/**
 * Load the language pack for the id — dynamic import so each parser lands in
 * its own lazy chunk and is fetched only when a file of that kind is opened.
 */
export async function loadLanguageSupport(id: EditorLanguageId): Promise<Extension | null> {
  switch (id) {
    case "javascript":
      return (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true });
    case "rust":
      return (await import("@codemirror/lang-rust")).rust();
    case "python":
      return (await import("@codemirror/lang-python")).python();
    case "json":
      return (await import("@codemirror/lang-json")).json();
    case "html":
      return (await import("@codemirror/lang-html")).html();
    case "css":
      return (await import("@codemirror/lang-css")).css();
    case "markdown":
      return (await import("@codemirror/lang-markdown")).markdown();
    default:
      return null;
  }
}

/**
 * Static (non-lazy) extension set: gutter, history, bracket matching,
 * autocompletion plumbing, keymaps, the search panel, and read-only wiring.
 * The language pack is appended separately by the host once lazily loaded.
 */
export async function buildEditorExtensions(options: {
  readOnly?: boolean;
  ariaLabel: string;
}): Promise<Extension[]> {
  const [
    { EditorState },
    { EditorView, keymap, drawSelection, dropCursor },
    { defaultKeymap, history, historyKeymap, indentWithTab },
    { bracketMatching, indentOnInput, foldGutter, foldKeymap, syntaxHighlighting, indentUnit, HighlightStyle },
    { search, searchKeymap, highlightSelectionMatches },
    { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap },
    { tags },
  ] = await Promise.all([
    import("@codemirror/state"),
    import("@codemirror/view"),
    import("@codemirror/commands"),
    import("@codemirror/language"),
    import("@codemirror/search"),
    import("@codemirror/autocomplete"),
    import("@lezer/highlight"),
  ]) as any;

  const highlight = HighlightStyle.define([
    { tag: tags.keyword, color: "var(--theme-accent)" },
    { tag: [tags.comment, tags.blockComment, tags.lineComment], color: "var(--theme-muted)" },
    { tag: [tags.string, tags.special(tags.string)], color: "#78a06b" },
    { tag: [tags.number, tags.bool, tags.null], color: "#c2975f" },
    { tag: [tags.definition(tags.variableName)], color: "var(--theme-text)" },
    { tag: [tags.tagName, tags.attributeName], color: "var(--theme-accent)" },
  ]);

  const readOnly = options.readOnly === true;
  return [
    history(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    bracketMatching(),
    foldGutter(),
    closeBrackets(),
    autocompletion(),
    highlightSelectionMatches(),
    syntaxHighlighting(highlight, { fallback: true }),
    search({ top: true }),
    indentUnit.of("    "),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      indentWithTab,
    ]),
    EditorState.allowMultipleSelections.of(true),
    ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
    EditorView.contentAttributes.of({
      "aria-label": options.ariaLabel,
      spellcheck: "false",
    }),
  ];
}
