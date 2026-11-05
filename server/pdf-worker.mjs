import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// PDF text is untrusted. Only PDF.js's bundled CMaps/fonts may be loaded.
globalThis.fetch = async () => { throw new Error("External PDF resources are disabled."); };
const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve("pdfjs-dist/package.json"));
class LocalBinaryDataFactory {
  async fetch({ kind, filename }) {
    const directory = { cMapUrl: "cmaps", standardFontDataUrl: "standard_fonts" }[kind];
    if (!directory || typeof filename !== "string" || !/^[A-Za-z0-9_.-]+$/.test(filename) || filename.includes("..")) {
      throw new Error("External PDF resources are disabled.");
    }
    return new Uint8Array(await readFile(join(packageRoot, directory, filename)));
  }
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

let task;
let pdf;
try {
  task = getDocument({
    data: new Uint8Array(workerData.bytes),
    BinaryDataFactory: LocalBinaryDataFactory,
    cMapUrl: "bundled-cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "bundled-standard-fonts/",
    useWorkerFetch: false,
    useSystemFonts: false,
    disableFontFace: true,
    isEvalSupported: false,
    useWasm: false,
    enableXfa: false,
    stopAtErrors: true,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    maxImageSize: 1_000_000,
    verbosity: 0,
  });
  pdf = await task.promise;
  if (pdf.numPages > workerData.maxPages) fail("PDF_PAGE_LIMIT");
  const pages = [];
  let characters = 0;
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const parts = [];
    for (const item of content.items) {
      if (typeof item.str !== "string") continue;
      const part = item.str.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
      // Count before joining, so a huge single page cannot create an unbounded string.
      characters += part.length + 1;
      if (characters > workerData.maxTextCharacters) fail("PDF_TEXT_LIMIT");
      parts.push(part, item.hasEOL ? "\n" : " ");
    }
    const text = parts.join("").trim();
    pages.push({ page: pageNumber, text });
    page.cleanup();
  }
  if (!pages.some(({ text }) => text.trim())) fail("PDF_NO_TEXT");
  const result = { pageCount: pdf.numPages, pages };
  await pdf.destroy();
  pdf = undefined;
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  const known = new Set(["PDF_PAGE_LIMIT", "PDF_TEXT_LIMIT", "PDF_NO_TEXT"]);
  const code = known.has(error?.code) ? error.code
    : error?.name === "PasswordException" ? "PDF_PASSWORD" : "INVALID_PDF";
  parentPort.postMessage({ ok: false, code });
} finally {
  try { await (pdf ? pdf.destroy() : task?.destroy()); } catch { /* Worker is disposable. */ }
}
