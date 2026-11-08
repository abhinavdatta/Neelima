// Editor setup tests: language mapping and extension assembly (no DOM needed).
import test from "node:test";
import assert from "node:assert/strict";
import { languageIdForFilename } from "../src/editorSetup.ts";

test("language map covers the allowed text/source extensions", () => {
  const cases = {
    "app.js": "javascript",
    "widget.jsx": "javascript",
    "service.ts": "javascript",
    "app.tsx": "javascript",
    "lib.rs": "rust",
    "main.py": "python",
    "package.json": "json",
    "index.html": "html",
    "styles.css": "css",
    "_styles.scss": "css",
    "README.md": "markdown",
    "guide.markdown": "markdown",
    "doc.mdx": "markdown",
  };
  for (const [path, expected] of Object.entries(cases)) {
    assert.equal(languageIdForFilename(path), expected, path);
  }
});

test("language map is case-insensitive and extension-only", () => {
  assert.equal(languageIdForFilename("Main.PY"), "python");
  assert.equal(languageIdForFilename("some_dir/lib.rs"), "rust");
  assert.equal(languageIdForFilename("C:\\ws\\nested\\Data.JSON"), "json");
});

test("unsupported and extensionless names stay plain text", () => {
  assert.equal(languageIdForFilename("notes.toml"), null);
  assert.equal(languageIdForFilename("script.sh"), null);
  assert.equal(languageIdForFilename("Makefile"), null);
  assert.equal(languageIdForFilename("data.csv"), null);
  assert.equal(languageIdForFilename("backup.log"), null);
});

test("buildEditorExtensions assembles the base set with read-only wiring", async () => {
  const { buildEditorExtensions } = await import("../src/editorSetup.ts");
  const editable = await buildEditorExtensions({ ariaLabel: "Editing a.py" });
  assert.ok(Array.isArray(editable) && editable.length >= 10, "full base extension set");
  const readOnly = await buildEditorExtensions({ ariaLabel: "Editing a.py", readOnly: true });
  assert.ok(readOnly.length > editable.length, "read-only adds its facet extensions");
});
