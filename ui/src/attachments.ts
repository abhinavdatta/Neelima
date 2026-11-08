export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 30 * 1024 * 1024;
export const MAX_ATTACHMENT_TEXT_CHARS = 24_000;
export const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const textExtensions = new Set(["txt", "md", "markdown", "csv", "json", "log"]);
const documentExtensions = new Set(["pdf", "docx"]);
const MAX_TEXT_INPUT_BYTES = 96 * 1024;

export type AttachmentKind = "image" | "document";
export type AttachmentFile = Pick<File, "name" | "type" | "size" | "arrayBuffer" | "text" | "slice">;

export function validateAttachment(file: Pick<File, "name" | "type" | "size">, currentBytes: number): { kind?: AttachmentKind; error?: string } {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const image = ALLOWED_IMAGE_TYPES.has(file.type);
  const supportedText = textExtensions.has(extension) || documentExtensions.has(extension) ||
    ["text/plain", "text/markdown", "text/csv", "application/json", "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"].includes(file.type);
  if (!image && !supportedText) {
    return { error: "Unsupported file type. Choose PDF, DOCX, TXT, Markdown, CSV, JSON, or PNG/JPEG/GIF/WebP." };
  }
  if (file.size === 0 || file.size > MAX_ATTACHMENT_BYTES) {
    return { error: "Attachment must be between 1 byte and 15 MB." };
  }
  if (currentBytes + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
    return { error: "Selected attachments may not exceed 30 MB total." };
  }
  return { kind: image ? "image" : "document" };
}

/// Join extracted PDF pages, keeping page references. Returns "" when no page
/// had real text: an image-only (scanned) PDF must not look like an extraction
/// success just because it has page markers.
export function joinPdfPages(pages: { page: number; text: string }[]): string {
  if (!pages.some((p) => p.text.trim().length > 0)) return "";
  return pages
    .map((p) => `[Page ${p.page}]\n${p.text.trim()}`)
    .join("\n\n")
    .slice(0, MAX_ATTACHMENT_TEXT_CHARS);
}

export async function extractAttachmentText(file: AttachmentFile): Promise<string> {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "pdf" || file.type === "application/pdf") {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).toString();
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    const document = await loadingTask.promise;
    const pages: { page: number; text: string }[] = [];
    let chars = 0;
    try {
      for (let pageNumber = 1; pageNumber <= document.numPages && chars < MAX_ATTACHMENT_TEXT_CHARS; pageNumber++) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = content.items.map((item) => "str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : "").join("").trim();
        pages.push({ page: pageNumber, text });
        chars += text.length;
      }
    } finally {
      await loadingTask.destroy();
    }
    return joinPdfPages(pages);
  }
  if (extension === "docx" || file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const mammoth = await import("mammoth");
    const extracted = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    const warnings = extracted.messages.filter((message) => message.type === "warning").map((message) => message.message);
    const warningNote = warnings.length ? `\n\n[DOCX extraction warnings: ${warnings.join("; ").slice(0, 1000)}]` : "";
    return `${extracted.value.slice(0, MAX_ATTACHMENT_TEXT_CHARS)}${warningNote}`;
  }
  if (textExtensions.has(extension) || ["text/plain", "text/markdown", "text/csv", "application/json"].includes(file.type)) {
    const bytes = new Uint8Array(await file.slice(0, Math.min(file.size, MAX_TEXT_INPUT_BYTES)).arrayBuffer());
    if (bytes.includes(0)) throw new Error("File appears binary; refusing to treat it as text.");
    const text = new TextDecoder().decode(bytes).slice(0, MAX_ATTACHMENT_TEXT_CHARS);
    return file.size > MAX_TEXT_INPUT_BYTES ? `${text}\n[Text extraction limited to the first ${MAX_TEXT_INPUT_BYTES.toLocaleString()} bytes.]` : text;
  }
  throw new Error("Supported document types: PDF, DOCX, TXT, Markdown, CSV and JSON.");
}
