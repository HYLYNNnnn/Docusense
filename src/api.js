export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_QUESTION_CHARACTERS = 2000;
export const SESSION_EXPIRED_EVENT = "docusense:session-expired";
const SESSION_KEY = "docusense.session";
const DOCUMENT_KEY = "docusense.document";
const API_BASE = (process.env.REACT_APP_API_BASE || "/api").replace(/\/+$/, "");
let memorySession = null;

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function getSessionId() {
  try { return sessionStorage.getItem(SESSION_KEY) || memorySession; }
  catch { return memorySession; }
}

function saveSession(id, previous) {
  if (typeof id !== "string" || !id.trim() || /[\r\n]/.test(id) || id.length > 1024 || (previous && previous !== id)) {
    throw new ApiError("The server returned an invalid document session.");
  }
  memorySession = id;
  try { sessionStorage.setItem(SESSION_KEY, id); } catch { /* Continue in this tab's memory. */ }
}

export function clearSession() {
  memorySession = null;
  try { sessionStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(DOCUMENT_KEY); } catch { /* Storage may be unavailable. */ }
}

export function getSelectedDocumentId() {
  try { return sessionStorage.getItem(DOCUMENT_KEY) || ""; } catch { return ""; }
}
export function rememberSelectedDocument(id) {
  try { if (id) sessionStorage.setItem(DOCUMENT_KEY, id); else sessionStorage.removeItem(DOCUMENT_KEY); }
  catch { /* Selection can remain in component state. */ }
}

function expireSession() {
  clearSession();
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}

async function request(path, options = {}) {
  const session = getSessionId();
  const headers = { ...options.headers };
  if (session) headers["X-Session-Id"] = session;
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, { credentials: "same-origin", ...options, headers });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new ApiError("Cannot reach the document server. Please try again.");
  }
  let data;
  try {
    const text = await response.text();
    data = text ? JSON.parse(text) : undefined;
  } catch (error) {
    if (error.name === "AbortError") throw error;
    if (response.ok) throw new ApiError("The document server returned an invalid response.");
  }
  if (options.signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
  if (!response.ok) {
    if (response.status === 401 && getSessionId() === session) expireSession();
    const description = typeof data?.message === "string" ? data.message
      : typeof data?.error === "string" ? data.error : "The document request failed. Please try again.";
    throw new ApiError(description, response.status);
  }
  if (data?.session_id) saveSession(data.session_id, session || getSessionId());
  return data;
}

function requireDocument(document) {
  if (!document || typeof document.id !== "string" || !document.id || typeof document.name !== "string"
      || !Number.isInteger(document.page_count) || document.page_count < 1
      || !Number.isInteger(document.chunk_count) || document.chunk_count < 1) {
    throw new ApiError("The server did not return an indexed PDF.");
  }
  return document;
}

export async function listDocuments({ signal } = {}) {
  if (!getSessionId()) return { documents: [], session_id: null };
  const data = await request("/documents", { signal });
  if (!Array.isArray(data?.documents)) throw new ApiError("The server did not return your document list.");
  return { ...data, documents: data.documents.map(requireDocument) };
}

export async function getAIConfig({ signal } = {}) {
  const config = await request('/ai-config', { signal });
  if (typeof config?.server_configured !== 'boolean' || typeof config?.user_keys_allowed !== 'boolean'
      || typeof config?.chat_model !== 'string' || !config.chat_model
      || typeof config?.embedding_model !== 'string' || !config.embedding_model) {
    throw new ApiError('AI settings could not be loaded. Please try again.');
  }
  return config;
}

function aiHeaders({ keySource = 'server', apiKey } = {}) {
  if (!['server', 'personal'].includes(keySource)) throw new ApiError('Choose an API key source in AI settings.', 400);
  const headers = { 'X-AI-Key-Source': keySource };
  if (keySource === 'personal') {
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!key) throw new ApiError('Enter your OpenAI API key in AI settings.', 400);
    headers['X-OpenAI-Api-Key'] = key;
  }
  return headers;
}

export async function uploadDocument(file, { signal, ...connection } = {}) {
  if (!file || !/\.pdf$/i.test(file.name || "")
      || (file.type && !["application/pdf", "application/octet-stream"].includes(file.type))) {
    throw new ApiError("Select a PDF document.", 400);
  }
  if (!file.size || file.size > MAX_PDF_BYTES) throw new ApiError("Select a PDF no larger than 10 MiB.", 400);
  const body = new FormData();
  body.append("file", file);
  const result = await request("/upload", { method: "POST", body, signal, headers: aiHeaders(connection) });
  if (!getSessionId()) throw new ApiError("The server did not create a document session.");
  return { ...result, document: requireDocument(result?.document) };
}

export async function askQuestion(documentId, question, { signal, ...connection } = {}) {
  const text = typeof question === "string" ? question.trim() : "";
  if (!text || Array.from(text).length > MAX_QUESTION_CHARACTERS) {
    throw new ApiError("Ask a question using 1–2000 characters.", 400);
  }
  const session = getSessionId();
  if (!session || !documentId) throw new ApiError("Upload and select a PDF before asking a question.", 400);
  const data = await request("/chat", {
    method: "POST", signal,
    headers: { "Content-Type": "application/json", ...aiHeaders(connection) },
    body: JSON.stringify({ document_id: documentId, session_id: session, question: text }),
  });
  if (typeof data?.answer !== "string" || !data.answer.trim() || data.document_id !== documentId) {
    throw new ApiError("The server did not return an answer for the selected PDF.");
  }
  return { ...data, sources: Array.isArray(data.sources) ? data.sources.filter((source) => typeof source?.text === "string") : [] };
}

export async function deleteDocument(documentId, { signal } = {}) {
  if (!getSessionId() || !documentId) throw new ApiError("Select a PDF to delete.", 400);
  await request(`/documents/${encodeURIComponent(documentId)}`, { method: "DELETE", signal });
}
