import test from "node:test";
import assert from "node:assert/strict";
import { DocumentStore } from "./document-store.js";

const bytes = (text = "test") => Buffer.from(`%PDF-${text}`);
const parsed = { pageCount: 2, pages: [{ page: 1, text: "Apples are red and grown in orchards." }, { page: 2, text: "Oranges contain vitamin C." }] };
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(t, { limits, now, parsePdf, provider: overrides = {} } = {}) {
  const calls = { parse: 0, documents: 0, queries: [], answers: [] };
  const provider = {
    isReady: () => true,
    async embedDocuments(texts) { calls.documents += 1; return texts.map(() => [1, 0.1]); },
    async embedQuery(text) { calls.queries.push(text); return [1, 0.1]; },
    async answer(input) { calls.answers.push(input); return `Answer to ${input.question} [p. 1]`; },
    ...overrides,
  };
  const store = new DocumentStore({ provider, limits, now, parsePdf: parsePdf ?? (async () => { calls.parse += 1; return structuredClone(parsed); }) });
  t.after(() => store.close());
  const sessionId = store.createSession();
  return { store, sessionId, calls, provider };
}

test("parses/embeds a PDF once, caches duplicate uploads and cites source pages", async (t) => {
  const { store, sessionId, calls } = setup(t);
  const document = await store.create(bytes(), { name: "folder\\notes.pdf", sessionId });
  assert.deepEqual(Object.keys(document).sort(), ["chunkCount", "id", "name", "pageCount"]);
  assert.equal(document.name, "notes.pdf");
  assert.equal(document.pageCount, 2);
  assert.equal(document.chunkCount, 2);
  const duplicate = await store.create(bytes(), { name: "another.pdf", sessionId });
  assert.equal(duplicate.id, document.id);
  const first = await store.ask({ documentId: document.id, sessionId, question: "What about apples?" });
  const second = await store.ask({ documentId: document.id, sessionId, question: "And oranges?" });
  assert.equal(calls.parse, 1);
  assert.equal(calls.documents, 1);
  assert.equal(calls.queries.length, 2);
  assert.deepEqual(first.sources.map(({ page }) => page), [1, 2]);
  assert.match(first.sources[0].text, /Apples/);
  assert.deepEqual(calls.answers[0].history, []);
  assert.deepEqual(calls.answers[1].history, [{ question: "What about apples?", answer: first.answer }]);
  assert.match(calls.queries[1], /What about apples\?/);
  assert.match(second.answer, /And oranges/);
});

test("keeps identical PDFs, conversation history and document access isolated by session", async (t) => {
  const { store, sessionId, calls } = setup(t);
  const other = store.createSession();
  assert.match(sessionId, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(sessionId, other);
  const a = await store.create(bytes(), { name: "a.pdf", sessionId });
  const b = await store.create(bytes(), { name: "b.pdf", sessionId: other });
  assert.notEqual(a.id, b.id);
  assert.equal(calls.documents, 2);
  await store.ask({ documentId: a.id, sessionId, question: "Private question" });
  await store.ask({ documentId: b.id, sessionId: other, question: "Other question" });
  assert.deepEqual(calls.answers[1].history, []);
  await assert.rejects(store.ask({ documentId: a.id, sessionId: other, question: "Leak?" }), { status: 404, code: "DOCUMENT_NOT_FOUND" });
  assert.throws(() => store.delete(a.id, other), { status: 404, code: "DOCUMENT_NOT_FOUND" });
  assert.deepEqual(store.list(other).map(({ id }) => id), [b.id]);
  assert.throws(() => store.list("unknown"), { status: 401, code: "SESSION_EXPIRED" });
});

test("bounds history to six completed turns and returns independent copies", async (t) => {
  const { store, sessionId, calls } = setup(t);
  const document = await store.create(bytes(), { sessionId });
  for (let i = 0; i < 8; i += 1) await store.ask({ documentId: document.id, sessionId, question: `Question ${i}` });
  assert.equal(calls.answers[7].history.length, 6);
  assert.equal(calls.answers[7].history[0].question, "Question 1");
  calls.answers[7].history[0].answer = "Mutated by provider";
  await store.ask({ documentId: document.id, sessionId, question: "Another" });
  assert.equal(calls.answers[8].history[0].question, "Question 2");
  assert.doesNotMatch(JSON.stringify(calls.answers[8].history), /Mutated/);
});

test("serializes questions per document and bounds its waiting queue", async (t) => {
  const first = deferred();
  const inputs = [];
  const { store, sessionId } = setup(t, { provider: { async answer(input) { inputs.push(input); return inputs.length === 1 ? first.promise : `Done ${input.question}`; } } });
  const document = await store.create(bytes(), { sessionId });
  const ask = (question) => store.ask({ documentId: document.id, sessionId, question });
  const pending = [ask("one"), ask("two"), ask("three"), ask("four")];
  await nextTurn();
  assert.equal(inputs.length, 1);
  await assert.rejects(ask("five"), { status: 429, code: "QUESTION_LIMIT" });
  first.resolve("First answer");
  const results = await Promise.all(pending);
  assert.equal(results.length, 4);
  assert.deepEqual(inputs[1].history, [{ question: "one", answer: "First answer" }]);
  assert.equal(inputs[3].history.length, 3);
});

test("a failed answer does not poison history or later queued questions", async (t) => {
  let attempts = 0;
  const inputs = [];
  const { store, sessionId } = setup(t, { provider: { async answer(input) { inputs.push(input); if (!attempts++) throw Object.assign(new Error("Unavailable"), { status: 502, code: "AI_UNAVAILABLE" }); return "Recovered"; } } });
  const document = await store.create(bytes(), { sessionId });
  const failure = store.ask({ documentId: document.id, sessionId, question: "Fail" });
  const success = store.ask({ documentId: document.id, sessionId, question: "Recover" });
  await assert.rejects(failure, { code: "AI_UNAVAILABLE" });
  assert.equal((await success).answer, "Recovered");
  assert.deepEqual(inputs[1].history, []);
});

test("deleting a document immediately cancels outstanding and queued questions", async (t) => {
  const answer = deferred();
  let receivedSignal;
  const { store, sessionId } = setup(t, { provider: { async answer({ signal }) { receivedSignal = signal; return answer.promise; } } });
  const document = await store.create(bytes(), { sessionId });
  const active = store.ask({ documentId: document.id, sessionId, question: "Wait" });
  const queued = store.ask({ documentId: document.id, sessionId, question: "Also wait" });
  const activeRejection = assert.rejects(active, { code: "REQUEST_ABORTED" });
  const queuedRejection = assert.rejects(queued, { code: "REQUEST_ABORTED" });
  await nextTurn();
  store.delete(document.id, sessionId);
  assert.equal(receivedSignal.aborted, true);
  await Promise.all([activeRejection, queuedRejection]);
  assert.deepEqual(store.list(sessionId), []);
  answer.resolve("Too late");
  await nextTurn();
  await assert.rejects(store.ask({ documentId: document.id, sessionId, question: "Again" }), { status: 404 });
});

test("deduplicates concurrent uploads and releases failed reservations", async (t) => {
  const parse = deferred();
  let parses = 0;
  const { store, sessionId, calls } = setup(t, { limits: { maxConcurrentUploads: 1 }, parsePdf: async () => { parses += 1; return parse.promise; } });
  const a = store.create(bytes(), { sessionId });
  const b = store.create(bytes(), { sessionId });
  await assert.rejects(store.create(bytes("different"), { sessionId }), { status: 429, code: "UPLOAD_LIMIT" });
  parse.resolve(structuredClone(parsed));
  assert.equal((await a).id, (await b).id);
  assert.equal(parses, 1);
  assert.equal(calls.documents, 1);
  const { store: failing, sessionId: failedSession, provider } = setup(t, { provider: { async embedDocuments() { throw Object.assign(new Error("Missing key"), { status: 503, code: "AI_NOT_CONFIGURED" }); } } });
  await assert.rejects(failing.create(bytes(), { sessionId: failedSession }), { status: 503, code: "AI_NOT_CONFIGURED" });
  assert.deepEqual(failing.list(failedSession), []);
  provider.embedDocuments = async (texts) => texts.map(() => [1, 0]);
  assert.equal((await failing.create(bytes(), { sessionId: failedSession })).chunkCount, 2);
});

test("enforces session/document limits and expires idle sessions", async (t) => {
  let time = 100;
  const { store, sessionId } = setup(t, { now: () => time, limits: { maxSessions: 1, maxDocumentsPerSession: 1, sessionTtlMs: 1000 } });
  assert.throws(() => store.createSession(), { code: "SESSION_LIMIT" });
  const document = await store.create(bytes(), { sessionId });
  await assert.rejects(store.create(bytes("other"), { sessionId }), { code: "DOCUMENT_LIMIT" });
  store.delete(document.id, sessionId);
  await store.create(bytes("replacement"), { sessionId });
  time += 1001;
  assert.throws(() => store.ensureSession(sessionId), { status: 401 });
  assert.notEqual(store.createSession(), sessionId);
});

test("reserves global document capacity before concurrent uploads finish", async (t) => {
  const parse = deferred();
  const { store, sessionId } = setup(t, { limits: { maxDocuments: 1 }, parsePdf: () => parse.promise });
  const otherSession = store.createSession();
  const indexing = store.create(bytes(), { sessionId });
  await assert.rejects(store.create(bytes("other"), { sessionId: otherSession }), { status: 429, code: "UPLOAD_LIMIT" });
  parse.resolve(structuredClone(parsed));
  const document = await indexing;
  await assert.rejects(store.create(bytes("other"), { sessionId: otherSession }), { status: 429, code: "UPLOAD_LIMIT" });
  store.delete(document.id, sessionId);
  assert.ok(await store.create(bytes("other"), { sessionId: otherSession }));
});

test("rejects unconfigured providers and bad data without committing an index", async (t) => {
  const { store, sessionId, provider, calls } = setup(t, { provider: { isReady: () => false } });
  assert.equal(store.isReady(), false);
  await assert.rejects(store.create(bytes(), { sessionId }), { status: 503, code: "AI_NOT_CONFIGURED" });
  assert.equal(calls.parse, 0);
  provider.isReady = () => true;
  await assert.rejects(store.create(Buffer.from("bad"), { sessionId }), { status: 400, code: "INVALID_PDF" });
  provider.embedDocuments = async () => [[NaN], [1]];
  await assert.rejects(store.create(bytes(), { sessionId }), { status: 502, code: "AI_INVALID_RESPONSE" });
  assert.deepEqual(store.list(sessionId), []);
});

test("bounds extraction/chunks and validates questions and query dimensions", async (t) => {
  const { store, sessionId, provider } = setup(t, { limits: { maxChunks: 1, chunkSize: 20, chunkOverlap: 0 } });
  await assert.rejects(store.create(bytes(), { sessionId }), { status: 413, code: "PDF_CHUNK_LIMIT" });
  const { store: ready, sessionId: id, provider: ai } = setup(t);
  const document = await ready.create(bytes(), { sessionId: id });
  await assert.rejects(ready.ask({ documentId: document.id, sessionId: id, question: " " }), { status: 400, code: "INVALID_QUESTION" });
  await assert.rejects(ready.ask({ documentId: document.id, sessionId: id, question: "x".repeat(2001) }), { status: 400 });
  ai.embedQuery = async () => [1];
  await assert.rejects(ready.ask({ documentId: document.id, sessionId: id, question: "Apples?" }), { status: 502, code: "AI_INVALID_RESPONSE" });
  assert.equal(provider.isReady(), true);
});

test("counts Unicode code points and discards only empty inactive sessions", async (t) => {
  const { store, sessionId } = setup(t);
  store.discardEmptySession(sessionId);
  assert.throws(() => store.ensureSession(sessionId), { status: 401 });
  const owner = store.createSession();
  const document = await store.create(bytes(), { sessionId: owner });
  store.discardEmptySession(owner);
  assert.equal(store.ensureSession(owner), owner);
  assert.ok(await store.ask({ documentId: document.id, sessionId: owner, question: "😀".repeat(2000) }));
  await assert.rejects(store.ask({ documentId: document.id, sessionId: owner, question: "😀".repeat(2001) }), { code: "INVALID_QUESTION" });
  const parse = deferred();
  const { store: waiting, sessionId: uploading } = setup(t, { parsePdf: () => parse.promise });
  const pending = waiting.create(bytes(), { sessionId: uploading });
  waiting.discardEmptySession(uploading);
  assert.equal(waiting.ensureSession(uploading), uploading);
  parse.resolve(structuredClone(parsed));
  await pending;
});
