import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../app.js";
import { fakeProvider, FakeStore, pdfFixture } from "../test-support/http-fixtures.js";

const allowedOrigin = "http://localhost:3000";
const pdf = pdfFixture();

async function startApp(t, { configured = true, requestTimeoutMs = 5_000 } = {}) {
  const staticDir = await mkdtemp(path.join(os.tmpdir(), "docusense-http-"));
  await writeFile(path.join(staticDir, "index.html"), "<html>DocuSense test frontend</html>");
  const provider = fakeProvider({ configured });
  const store = new FakeStore(provider);
  const app = createApp({
    store,
    provider,
    staticDir,
    corsOrigins: [allowedOrigin],
    requestTimeoutMs,
    maxConcurrentUploads: 2,
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
    await rm(staticDir, { recursive: true, force: true });
  });
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { store, request: (route, options) => fetch(`${baseUrl}${route}`, options) };
}

function upload(request, { bytes = pdf, name = "guide.pdf", type = "application/pdf", sessionId } = {}) {
  const body = new FormData();
  body.append("file", new Blob([bytes], { type }), name);
  return request("/api/upload", {
    method: "POST",
    headers: sessionId ? { "X-Session-Id": sessionId } : {},
    body,
  });
}

function chat(request, sessionId, body) {
  return request("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(sessionId ? { "X-Session-Id": sessionId } : {}) },
    body: JSON.stringify(body),
  });
}

async function json(response, status) {
  assert.equal(response.status, status);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  const body = await response.json();
  assert.equal(typeof body, "object");
  assert.notEqual(body, null);
  return body;
}

async function uploaded(request, options) {
  const body = await json(await upload(request, options), 201);
  assert.match(body.session_id, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(body.document.name, options?.name ?? "guide.pdf");
  assert.equal(body.document.page_count, 1);
  assert.equal(body.document.chunk_count, 1);
  assert.equal(typeof body.document.id, "string");
  return body;
}

test("health, API errors, CORS and missing static assets behave consistently", async (t) => {
  const { request } = await startApp(t);
  await json(await request("/api/health"), 200);
  await json(await request("/api/missing"), 404);
  const page = await request("/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /DocuSense test frontend/);
  assert.equal((await request("/assets/missing.js")).status, 404);

  const allowed = await request("/api/health", { headers: { Origin: allowedOrigin } });
  assert.equal(allowed.headers.get("access-control-allow-origin"), allowedOrigin);
  const denied = await request("/api/health", { headers: { Origin: "https://untrusted.example" } });
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
  const preflight = await request("/api/chat", {
    method: "OPTIONS",
    headers: {
      Origin: allowedOrigin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,x-session-id",
    },
  });
  assert.ok([200, 204].includes(preflight.status));
  assert.equal(preflight.headers.get("access-control-allow-origin"), allowedOrigin);
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /x-session-id/i);
});

test("missing, non-PDF and oversized uploads are rejected before creating a document", async (t) => {
  const { request, store } = await startApp(t);
  const emptyForm = new FormData();
  await json(await request("/api/upload", { method: "POST", body: emptyForm }), 400);
  for (const options of [
    { bytes: Buffer.from("not a PDF"), name: "notes.txt", type: "text/plain" },
    { bytes: Buffer.from("<html>not a PDF</html>"), name: "pretend.pdf" },
  ]) {
    const response = await upload(request, options);
    assert.ok([400, 415].includes(response.status));
    await json(response, response.status);
  }
  const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 32);
  pdf.copy(oversized);
  await json(await upload(request, { bytes: oversized }), 413);
  assert.equal(store.calls.create.length, 0);
});

test("a missing AI key returns a usable JSON 503 without storing the upload", async (t) => {
  const { request, store } = await startApp(t, { configured: false });
  const body = await json(await upload(request), 503);
  assert.ok(body.message);
  assert.equal(body.code, "AI_NOT_CONFIGURED");
  assert.equal(store.documents.size, 0);
});

test("upload, list, repeated chat and delete keep one document and its session", async (t) => {
  const { request, store } = await startApp(t);
  const { document, session_id: sessionId } = await uploaded(request, { name: "course notes.pdf" });
  const headers = { "X-Session-Id": sessionId };
  const listing = await json(await request("/api/documents", { headers }), 200);
  assert.deepEqual(listing.documents, [document]);
  assert.equal(listing.session_id, sessionId);
  for (const body of [
    { document_id: document.id, question: "What does the document say?" },
    { document_id: document.id, question: "Explain it again.", session_id: sessionId },
  ]) {
    const answer = await json(await chat(request, sessionId, body), 200);
    assert.equal(typeof answer.answer, "string");
    assert.ok(answer.answer.length > 0);
    assert.ok(Array.isArray(answer.sources));
  }
  assert.equal(store.calls.create.length, 1);
  assert.deepEqual(store.calls.create[0].buffer, pdf);
  assert.equal(store.calls.create[0].name, "course notes.pdf");
  assert.equal(store.calls.ask.length, 2);
  assert.ok(store.calls.ask.every((call) => call.documentId === document.id && call.sessionId === sessionId));
  assert.equal((await request(`/api/documents/${document.id}`, { method: "DELETE", headers })).status, 204);
  assert.deepEqual((await json(await request("/api/documents", { headers }), 200)).documents, []);
  await json(await chat(request, sessionId, { document_id: document.id, question: "Still there?" }), 404);
});

test("one session cannot list, ask about or delete another session's documents", async (t) => {
  const { request } = await startApp(t);
  const first = await uploaded(request, { name: "first.pdf" });
  const second = await uploaded(request, { name: "second.pdf" });
  const secondHeaders = { "X-Session-Id": second.session_id };
  assert.deepEqual((await json(await request("/api/documents", { headers: secondHeaders }), 200)).documents, [second.document]);
  await json(await chat(request, second.session_id, { document_id: first.document.id, question: "Read this." }), 404);
  await json(await request(`/api/documents/${first.document.id}`, { method: "DELETE", headers: secondHeaders }), 404);
  const firstListing = await json(await request("/api/documents", { headers: { "X-Session-Id": first.session_id } }), 200);
  assert.deepEqual(firstListing.documents, [first.document]);
});

test("document routes require a session header and reject conflicting body sessions", async (t) => {
  const { request, store } = await startApp(t);
  const first = await uploaded(request);
  await json(await request("/api/documents"), 401);
  await json(await chat(request, undefined, {
    document_id: first.document.id, question: "Read this.", session_id: first.session_id,
  }), 401);
  await json(await request(`/api/documents/${first.document.id}`, { method: "DELETE" }), 401);
  await json(await request("/api/documents", { headers: { "X-Session-Id": "A".repeat(43) } }), 401);
  const otherSession = store.createSession();
  await json(await chat(request, first.session_id, {
    document_id: first.document.id, question: "Read this.", session_id: otherSession,
  }), 400);
  assert.equal(store.calls.ask.length, 0);
});

test("unexpected failures produce JSON without upstream details or stack traces", async (t) => {
  const { request, store } = await startApp(t);
  const { document, session_id: sessionId } = await uploaded(request);
  store.askError = new Error("private upstream response: sk-secret-fixture, internal.database.local");
  const body = await json(await chat(request, sessionId, { document_id: document.id, question: "Read this." }), 500);
  assert.ok(body.message);
  assert.equal(body.code, "INTERNAL_ERROR");
  assert.doesNotMatch(JSON.stringify(body), /private upstream|sk-secret-fixture|internal\.database|\bat .*http\.test|stack/i);
});

test("a noncooperative question handler still receives a bounded JSON timeout", async (t) => {
  const { request, store } = await startApp(t, { requestTimeoutMs: 30 });
  const { document, session_id: sessionId } = await uploaded(request);
  store.ask = () => new Promise(() => {});
  const body = await json(await chat(request, sessionId, { document_id: document.id, question: 'Read this.' }), 504);
  assert.equal(body.code, 'REQUEST_TIMEOUT');
});

test("library errors with status and filesystem codes do not disclose local paths", async (t) => {
  const { request, store } = await startApp(t);
  const { document, session_id: sessionId } = await uploaded(request);
  store.askError = Object.assign(new Error('private filesystem path /secret/document.pdf'), { code: 'ENOENT', status: 400 });
  const body = await json(await chat(request, sessionId, { document_id: document.id, question: 'Read this.' }), 500);
  assert.doesNotMatch(JSON.stringify(body), /secret|filesystem|ENOENT/);
});
