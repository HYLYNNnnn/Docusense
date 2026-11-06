import {
  ApiError, askQuestion, clearSession, deleteDocument, getSessionId, listDocuments,
  MAX_PDF_BYTES, SESSION_EXPIRED_EVENT, uploadDocument,
  getAIConfig,
} from "./api";

const session = "a".repeat(64);
const document = { id: "doc-a", name: "Guide.pdf", page_count: 2, chunk_count: 4 };
const pdf = () => new File(["%PDF-1.4\nexample"], "Guide.pdf", { type: "application/pdf" });
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => data === undefined ? "" : JSON.stringify(data) });
const seed = () => sessionStorage.setItem("docusense.session", session);

beforeEach(() => { clearSession(); sessionStorage.clear(); global.fetch = jest.fn(); });
afterEach(() => { clearSession(); });

test("first upload creates a tab session and sends the PDF without a manual multipart header", async () => {
  fetch.mockResolvedValue(response({ document, session_id: session }, 201));
  const file = pdf();
  const result = await uploadDocument(file);
  expect(result.document).toEqual(document);
  expect(getSessionId()).toBe(session);
  const [url, options] = fetch.mock.calls[0];
  expect(url).toBe("/api/upload");
  expect(options.headers["X-Session-Id"]).toBeUndefined();
  expect(options.headers["Content-Type"]).toBeUndefined();
  expect(options.body.get("file")).toBe(file);
});

test("existing uploads reuse the current capability", async () => {
  seed(); fetch.mockResolvedValue(response({ document, session_id: session }, 201));
  await uploadDocument(pdf());
  expect(fetch.mock.calls[0][1].headers["X-Session-Id"]).toBe(session);
});

test("question text is JSON tied to a specific document and session", async () => {
  seed(); fetch.mockResolvedValue(response({ answer: "An answer", document_id: document.id, session_id: session, sources: [{ page: 2, text: "Source text" }] }));
  const result = await askQuestion(document.id, "  What & why?  ");
  expect(result.sources).toHaveLength(1);
  const [url, options] = fetch.mock.calls[0];
  expect(url).toBe("/api/chat");
  expect(options.method).toBe("POST");
  expect(options.headers["X-Session-Id"]).toBe(session);
  expect(JSON.parse(options.body)).toEqual({ document_id: document.id, session_id: session, question: "What & why?" });
});

test("session document list and deletion use the capability header", async () => {
  seed();fetch.mockResolvedValueOnce(response({ documents: [document], session_id: session })).mockResolvedValueOnce(response(undefined, 204));
  expect((await listDocuments()).documents).toEqual([document]);
  await deleteDocument(document.id);
  expect(fetch.mock.calls[1][0]).toBe("/api/documents/doc-a");
  expect(fetch.mock.calls[1][1]).toMatchObject({ method: "DELETE", headers: { "X-Session-Id": session } });
});

test("a new tab does not request another tab's documents", async () => {
  expect(await listDocuments()).toEqual({ documents: [], session_id: null });
  expect(fetch).not.toHaveBeenCalled();
});

test.each([
  new File(["html"], "bad.html", { type: "text/html" }),
  new File(["html"], "bad.pdf", { type: "text/html" }),
  new File([], "empty.pdf", { type: "application/pdf" }),
  { name: "huge.pdf", type: "application/pdf", size: MAX_PDF_BYTES + 1 },
])("rejects invalid PDF selections before a network call", async (file) => {
  await expect(uploadDocument(file)).rejects.toBeInstanceOf(ApiError);
  expect(fetch).not.toHaveBeenCalled();
});

test("blank or over-limit questions do not call the server; Unicode limit is by character", async () => {
  seed();
  for (const question of ["   ", "x".repeat(2001), "😀".repeat(2001)]) {
    await expect(askQuestion(document.id, question)).rejects.toBeInstanceOf(ApiError);
  }
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockResolvedValue(response({ answer: "Unicode accepted", document_id: document.id, session_id: session, sources: [] }));
  await expect(askQuestion(document.id, "😀".repeat(2000))).resolves.toMatchObject({ answer: "Unicode accepted" });
});

test("expired sessions clear the capability and notify the app", async () => {
  seed();const expired = jest.fn();window.addEventListener(SESSION_EXPIRED_EVENT, expired);
  fetch.mockResolvedValue(response({ message: "Your session expired" }, 401));
  try {
    await expect(listDocuments()).rejects.toMatchObject({ status: 401, message: "Your session expired" });
    expect(getSessionId()).toBeNull();expect(expired).toHaveBeenCalledTimes(1);
  } finally { window.removeEventListener(SESSION_EXPIRED_EVENT, expired); }
});

test("unknown documents do not invalidate the whole session", async () => {
  seed();fetch.mockResolvedValue(response({ message: "Document not found" }, 404));
  await expect(askQuestion("missing", "What?" )).rejects.toMatchObject({ status: 404 });
  expect(getSessionId()).toBe(session);
});

test("obsolete aborted responses cannot expire the current session", async () => {
  seed();const controller = new AbortController();let finish;let enterBody;
  const readingBody = new Promise((resolve) => { enterBody = resolve; });
  fetch.mockResolvedValue({ ok: false, status: 401, text: () => new Promise((resolve) => {
    finish = resolve;enterBody();
  }) });
  const pending = listDocuments({ signal: controller.signal });
  await readingBody;
  controller.abort();finish(JSON.stringify({ message: "Expired" }));
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(getSessionId()).toBe(session);
});

test("network failures are plain safe errors and answers cannot come from the wrong PDF", async () => {
  seed();fetch.mockRejectedValueOnce(new TypeError("private connection detail"));
  await expect(listDocuments()).rejects.toMatchObject({ message: "Cannot reach the document server. Please try again." });
  fetch.mockResolvedValue(response({ answer: "Wrong file", document_id: "doc-b", session_id: session }));
  await expect(askQuestion(document.id, "What?")).rejects.toMatchObject({ message: "The server did not return an answer for the selected PDF." });
});

test("a response cannot silently replace an existing capability", async () => {
  seed();fetch.mockResolvedValue(response({ document, session_id: "b".repeat(64) }, 201));
  await expect(uploadDocument(pdf())).rejects.toBeInstanceOf(ApiError);
  expect(getSessionId()).toBe(session);
});

test('personal credentials are only sent on upload/chat headers, never stored or included in JSON', async () => {
  const options = { keySource: 'personal', apiKey: 'test-personal-key' };
  fetch.mockResolvedValueOnce(response({ document, session_id: session }, 201))
    .mockResolvedValueOnce(response({ answer: 'Answer', document_id: document.id, session_id: session }))
    .mockResolvedValueOnce(response({ documents: [document], session_id: session }));
  await uploadDocument(pdf(), options);
  await askQuestion(document.id, 'Question?', options);
  await listDocuments();
  const upload = fetch.mock.calls[0][1];
  const chat = fetch.mock.calls[1][1];
  expect(upload.headers['X-OpenAI-Api-Key']).toBe('test-personal-key');
  expect(upload.headers['X-AI-Key-Source']).toBe('personal');
  expect(chat.headers['X-OpenAI-Api-Key']).toBe('test-personal-key');
  expect(chat.body).not.toContain('test-personal-key');
  expect(fetch.mock.calls[2][1].headers['X-OpenAI-Api-Key']).toBeUndefined();
  expect(JSON.stringify({ ...sessionStorage, ...localStorage })).not.toContain('test-personal-key');
});

test('missing personal keys are blocked and never fall back to server credentials', async () => {
  seed();
  await expect(uploadDocument(pdf(), { keySource: 'personal', apiKey: ' ' })).rejects.toMatchObject({ status: 400 });
  await expect(askQuestion(document.id, 'Question?', { keySource: 'personal' })).rejects.toMatchObject({ status: 400 });
  expect(fetch).not.toHaveBeenCalled();
});

test('AI configuration reads do not send a key; provider auth errors preserve the document session', async () => {
  seed();
  const settings = { server_configured: false, user_keys_allowed: true,
    chat_model: 'gpt-5.6-terra', embedding_model: 'text-embedding-3-small' };
  fetch.mockResolvedValueOnce(response(settings)).mockResolvedValueOnce(response({ message: 'Selected key rejected' }, 503));
  expect(await getAIConfig()).toEqual(settings);
  expect(fetch.mock.calls[0][1].headers['X-OpenAI-Api-Key']).toBeUndefined();
  await expect(askQuestion(document.id, 'Question?', { keySource: 'personal', apiKey: 'test-key' }))
    .rejects.toMatchObject({ status: 503 });
  expect(getSessionId()).toBe(session);
});
