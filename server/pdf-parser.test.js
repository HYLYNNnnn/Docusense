import test from "node:test";
import assert from "node:assert/strict";
import { parsePdf } from "./pdf-parser.js";
import { makePdf, makeChinesePdf } from "./test-support/pdf-fixtures.js";

test("extracts page text and original page numbers from the exact Buffer view", async () => {
  const pdf = makePdf(["First page about apples", "Second page about oranges"]);
  const surrounding = Buffer.concat([Buffer.from("private prefix"), pdf, Buffer.from("private suffix")]);
  const view = surrounding.subarray(14, 14 + pdf.length);
  const parsed = await parsePdf(view);
  assert.equal(parsed.pageCount, 2);
  assert.deepEqual(parsed.pages.map(({ page }) => page), [1, 2]);
  assert.match(parsed.pages[0].text, /First page about apples/);
  assert.match(parsed.pages[1].text, /Second page about oranges/);
  assert.doesNotMatch(JSON.stringify(parsed), /private/);
});

test("extracts Chinese Unicode text without external resources", async () => {
  const parsed = await parsePdf(makeChinesePdf());
  assert.match(parsed.pages[0].text.replace(/\s/g, ""), /你好/);
});

test("rejects malformed, empty, oversized and page/text-limit PDFs", async () => {
  await assert.rejects(parsePdf(Buffer.from("not a PDF")), { code: "INVALID_PDF", status: 400 });
  await assert.rejects(parsePdf(Buffer.from("%PDF-invalid")), { code: "INVALID_PDF" });
  await assert.rejects(parsePdf(makePdf([""])), { code: "PDF_NO_TEXT", status: 422 });
  await assert.rejects(parsePdf(makePdf(), { limits: { maxPdfBytes: 10 } }), { code: "PDF_TOO_LARGE", status: 413 });
  await assert.rejects(parsePdf(makePdf(["a", "b"]), { limits: { maxPages: 1 } }), { code: "PDF_PAGE_LIMIT", status: 413 });
  await assert.rejects(parsePdf(makePdf(["A longer line"]), { limits: { maxTextCharacters: 3 } }), { code: "PDF_TEXT_LIMIT", status: 413 });
});

test("cancels and terminates PDF parsing within its deadline", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(parsePdf(makePdf(), { signal: controller.signal }), { code: "REQUEST_ABORTED", status: 499 });
  await assert.rejects(parsePdf(makePdf(), { limits: { parseTimeoutMs: 1 } }), { code: "PDF_TIMEOUT", status: 422 });
});
