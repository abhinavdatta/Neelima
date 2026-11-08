import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { transformSync } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../src/attachments.ts"), "utf8");
const { code } = transformSync(source, { loader: "ts", format: "cjs" });
const mod = { exports: {} };
new Function("module", "exports", code)(mod, mod.exports);
const { validateAttachment, extractAttachmentText, joinPdfPages, MAX_ATTACHMENT_BYTES, MAX_TOTAL_ATTACHMENT_BYTES, MAX_ATTACHMENT_TEXT_CHARS } = mod.exports;

function file({ name, type = "", size = 10, contents = "hello" }) {
  const bytes = new TextEncoder().encode(contents);
  return {
    name,
    type,
    size,
    text: async () => contents,
    arrayBuffer: async () => bytes.buffer,
    slice: (_start, end) => ({ arrayBuffer: async () => bytes.slice(0, end).buffer }),
  };
}

test("validates supported image/doc types, per-file and aggregate caps", () => {
  assert.deepEqual(validateAttachment(file({ name: "photo.png", type: "image/png" }), 0), { kind: "image" });
  assert.deepEqual(validateAttachment(file({ name: "report.pdf", type: "application/pdf" }), 0), { kind: "document" });
  assert.deepEqual(validateAttachment(file({ name: "notes.txt" }), 0), { kind: "document" });
  assert.match(validateAttachment(file({ name: "archive.zip" }), 0).error, /Unsupported/);
  assert.match(validateAttachment(file({ name: "huge.txt", size: MAX_ATTACHMENT_BYTES + 1 }), 0).error, /15 MB/);
  assert.match(validateAttachment(file({ name: "next.txt", size: 2 }), MAX_TOTAL_ATTACHMENT_BYTES - 1).error, /30 MB/);
});

test("plain text extraction is local, capped, and rejects NUL-containing data", async () => {
  assert.equal(await extractAttachmentText(file({ name: "memo.txt" })), "hello");
  const largeData = "x".repeat(96 * 1024);
  const bounded = await extractAttachmentText(file({ name: "large.md", size: 100_000, contents: largeData }));
  assert.ok(bounded.length <= MAX_ATTACHMENT_TEXT_CHARS + 100);
  assert.match(bounded, /limited to the first 98,304 bytes/);
  await assert.rejects(() => extractAttachmentText(file({ name: "not-text.txt", contents: "A\0B" })), /appears binary/);
});

// Phase 3M live defect: an image-only PDF produced page markers and was
// reported as "text extracted", inventing content for a scanned document.
test("image-only PDF yields no text so the composer can report it honestly", () => {
  assert.equal(joinPdfPages([{ page: 1, text: "" }]), "");
  assert.equal(joinPdfPages([{ page: 1, text: "  \n \t " }]), "");
  const text = joinPdfPages([{ page: 1, text: "Alpha page one" }, { page: 2, text: "Beta page two" }]);
  assert.equal(text, "[Page 1]\nAlpha page one\n\n[Page 2]\nBeta page two");
  // One text page among blank pages is still a real extraction.
  assert.match(joinPdfPages([{ page: 1, text: "" }, { page: 2, text: "Real" }]), /\[Page 2\]\nReal/);
});

test("DOCX extraction rejects malformed local documents instead of silently sending them", async () => {
  await assert.rejects(
    () => extractAttachmentText(file({ name: "broken.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })),
    /Could not find file|End of data|invalid/i,
  );
});
