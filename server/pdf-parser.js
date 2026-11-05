import { Worker } from "node:worker_threads";
import { RagError, throwIfAborted } from "./rag-error.js";

export const PDF_LIMITS = Object.freeze({
  maxPdfBytes: 10 * 1024 * 1024,
  maxPages: 100,
  maxTextCharacters: 300_000,
  parseTimeoutMs: 20_000,
});

export function validatePdfBuffer(buffer, limits = PDF_LIMITS) {
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
    throw new RagError(400, "INVALID_PDF", "Please upload a PDF file.");
  }
  if (buffer.byteLength > limits.maxPdfBytes) {
    throw new RagError(413, "PDF_TOO_LARGE", "The PDF is larger than the upload limit.");
  }
  if (buffer.byteLength < 5 || Buffer.from(buffer.subarray(0, 5)).toString("ascii") !== "%PDF-") {
    throw new RagError(400, "INVALID_PDF", "The uploaded file is not a valid PDF.");
  }
}

/** Extract text in a disposable worker; never retain the uploaded PDF after indexing. */
export async function parsePdf(buffer, { signal, limits: options = {} } = {}) {
  const limits = { ...PDF_LIMITS, ...options };
  throwIfAborted(signal);
  validatePdfBuffer(buffer, limits);
  // Copy the exact view, not buffer.buffer: uploaded Buffers may share a larger slab.
  const bytes = new Uint8Array(buffer);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./pdf-worker.mjs", import.meta.url), {
      workerData: {
        bytes: bytes.buffer,
        maxPages: limits.maxPages,
        maxTextCharacters: limits.maxTextCharacters,
      },
      transferList: [bytes.buffer],
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      env: { NODE_ENV: "production" },
      execArgv: [],
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      if (error) reject(error);
      else resolve(result);
    };
    const onAbort = () => finish(new RagError(499, "REQUEST_ABORTED", "The request was cancelled."));
    const timer = setTimeout(() => {
      finish(new RagError(422, "PDF_TIMEOUT", "This PDF took too long to process. Try a smaller PDF."));
    }, limits.parseTimeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    worker.once("message", (message) => {
      if (message?.ok) finish(null, message.result);
      else {
        const allowed = new Map([
          ["PDF_PAGE_LIMIT", [413, "The PDF has too many pages."]],
          ["PDF_TEXT_LIMIT", [413, "The PDF contains too much text."]],
          ["PDF_PASSWORD", [422, "Password-protected PDFs are not supported."]],
          ["PDF_NO_TEXT", [422, "This PDF has no selectable text. Please use a text PDF or run OCR first."]],
          ["INVALID_PDF", [400, "The uploaded PDF could not be read."]],
        ]);
        const code = allowed.has(message?.code) ? message.code : "INVALID_PDF";
        const [status, description] = allowed.get(code);
        finish(new RagError(status, code, description));
      }
    });
    worker.once("error", (error) => finish(new RagError(
      422,
      error?.code === "ERR_WORKER_OUT_OF_MEMORY" ? "PDF_RESOURCE_LIMIT" : "INVALID_PDF",
      "This PDF could not be processed. Try a smaller, unencrypted PDF.",
    )));
    worker.once("exit", () => {
      if (!settled) finish(new RagError(422, "PDF_RESOURCE_LIMIT", "This PDF could not be processed."));
    });
  });
}
