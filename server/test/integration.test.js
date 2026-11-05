import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { createApp } from "../app.js";
import { DocumentStore } from "../document-store.js";
import { createOpenAIProvider } from "../openai-provider.js";
import { parsePdf } from "../pdf-parser.js";
import { pdfFixture } from "../test-support/http-fixtures.js";

const documentText = "This course teaches document retrieval and question answering.";
const pdf = pdfFixture(documentText);
const malformedPdf = Buffer.from("%PDF-1.7\nThis is not a valid PDF document.\n%%EOF\n");
const mockAnswer = "The course teaches document retrieval and question answering. [p. 1]";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

function close(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

async function setup(t, limits = {}) {
  const calls = { embeddings: [], answers: [] };
  const upstream = http.createServer((req, res) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const call = { body, authorization: req.headers.authorization };
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/embeddings" && req.method === "POST") {
        calls.embeddings.push(call);
        res.end(JSON.stringify({
          data: body.input.map((text, index) => ({ index, embedding: [1, 1] })),
        }));
      } else if (req.url === "/v1/chat/completions" && req.method === "POST") {
        calls.answers.push(call);
        res.end(JSON.stringify({ choices: [{ message: { content: mockAnswer } }] }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "Unknown fixture endpoint" }));
      }
    })().catch(() => {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  });
  let apiServer;
  let store;
  t.after(async () => {
    store?.close();
    if (apiServer) await close(apiServer);
    await close(upstream);
  });
  const upstreamUrl = await listen(upstream);
  const provider = createOpenAIProvider({
    apiKey: "test-fixture-only",
    baseURL: `${upstreamUrl}/v1`,
    timeoutMs: 5_000,
  });
  store = new DocumentStore({ provider, limits });
  const app = createApp({ store, provider, requestTimeoutMs: 15_000 });
  apiServer = http.createServer(app);
  const apiUrl = await listen(apiServer);
  return { calls, store, request: (route, options) => fetch(`${apiUrl}${route}`, options) };
}

async function readJson(response, status) {
  assert.equal(response.status, status);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  return response.json();
}

function upload(request, { bytes = pdf, sessionId } = {}) {
  const body = new FormData();
  body.append("file", new Blob([bytes], { type: "application/pdf" }), "course.pdf");
  return request("/api/upload", {
    method: "POST",
    headers: sessionId ? { "X-Session-Id": sessionId } : {},
    body,
  });
}

function chat(request, sessionId, documentId, question) {
  return request("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Session-Id": sessionId },
    body: JSON.stringify({ document_id: documentId, question }),
  });
}

test("real PDF parsing, provider requests and HTTP sessions reuse one document index", async (t) => {
  const { request, store, calls } = await setup(t);
  const uploaded = await readJson(await upload(request), 201);
  const document = uploaded.document;
  const sessionId = uploaded.session_id;
  assert.equal(document.page_count, 1);
  assert.equal(document.chunk_count, 1);
  assert.match(sessionId, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(calls.embeddings.length, 1);
  assert.match(calls.embeddings[0].body.input[0], /document retrieval and question answering/);

  const firstQuestion = "What does the course teach?";
  const secondQuestion = "Can you explain that again?";
  for (const question of [firstQuestion, secondQuestion]) {
    const answer = await readJson(await chat(request, sessionId, document.id, question), 200);
    assert.equal(answer.answer, mockAnswer);
    assert.equal(answer.document_id, document.id);
    assert.equal(answer.session_id, sessionId);
    assert.ok(answer.sources.length > 0);
    assert.ok(answer.sources.every((source) => source.page === 1));
  }
  // One PDF batch, followed by one query embedding per question.
  assert.equal(calls.embeddings.length, 3);
  assert.deepEqual(calls.embeddings[1].body.input, [firstQuestion]);
  assert.ok(calls.embeddings[2].body.input[0].includes(firstQuestion));
  assert.ok(calls.embeddings[2].body.input[0].includes(secondQuestion));
  assert.equal(calls.answers.length, 2);
  const secondMessages = calls.answers[1].body.messages;
  assert.ok(secondMessages.some((message) => message.role === "user" && message.content === firstQuestion));
  assert.ok(secondMessages.some((message) => message.role === "assistant" && message.content === mockAnswer));
  assert.ok([...calls.embeddings, ...calls.answers].every((call) => call.authorization === "Bearer test-fixture-only"));

  const repeated = await readJson(await upload(request, { sessionId }), 201);
  assert.equal(repeated.document.id, document.id);
  assert.equal(calls.embeddings.length, 3);

  const otherSession = store.createSession();
  await readJson(await chat(request, otherSession, document.id, "Read this PDF."), 404);
  await readJson(await request(`/api/documents/${document.id}`, {
    method: "DELETE", headers: { "X-Session-Id": otherSession },
  }), 404);
  assert.equal(calls.embeddings.length, 3);

  assert.equal((await request(`/api/documents/${document.id}`, {
    method: "DELETE", headers: { "X-Session-Id": sessionId },
  })).status, 204);
  await readJson(await chat(request, sessionId, document.id, "Is it still available?"), 404);
  assert.equal(calls.embeddings.length, 3);
  assert.equal(calls.answers.length, 2);
});

test("a malformed PDF fails in the real worker and does not consume session capacity", async (t) => {
  await assert.rejects(parsePdf(malformedPdf), { status: 400, code: "INVALID_PDF" });
  const { request, calls } = await setup(t, { maxSessions: 1 });
  for (let attempt = 0; attempt < 2; attempt++) {
    const failed = await readJson(await upload(request, { bytes: malformedPdf }), 400);
    assert.equal(failed.code, "INVALID_PDF");
  }
  assert.equal(calls.embeddings.length, 0);
  const uploaded = await readJson(await upload(request), 201);
  assert.equal(uploaded.document.page_count, 1);
  assert.equal(calls.embeddings.length, 1);
});
