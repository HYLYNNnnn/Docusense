import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Document } from "langchain/document";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import { parsePdf as defaultParsePdf, PDF_LIMITS, validatePdfBuffer } from "./pdf-parser.js";
import { RagError, combineSignals, throwIfAborted } from "./rag-error.js";

export { RagError } from "./rag-error.js";

export const DEFAULT_LIMITS = Object.freeze({
  ...PDF_LIMITS,
  sessionTtlMs: 30 * 60 * 1000,
  maxSessions: 20,
  maxDocumentsPerSession: 3,
  maxDocuments: 30,
  maxConcurrentUploads: 2,
  maxChunks: 500,
  chunkSize: 1000,
  chunkOverlap: 150,
  retrievalCount: 4,
  maxHistoryTurns: 6,
  maxPendingQuestions: 4,
  maxQuestionCharacters: 2000,
  maxAnswerCharacters: 12_000,
});

function metadata(document) {
  return { id: document.id, name: document.name, pageCount: document.pageCount, chunkCount: document.chunkCount };
}

function validateVectors(vectors, expectedCount, expectedDimensions) {
  if (!Array.isArray(vectors) || vectors.length !== expectedCount || !vectors.length) {
    throw new RagError(502, "AI_INVALID_RESPONSE", "The AI service returned an invalid embedding response.");
  }
  const dimensions = expectedDimensions ?? vectors[0]?.length;
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 8192 || vectors.some((vector) => (
    !Array.isArray(vector) || vector.length !== dimensions ||
    vector.some((value) => !Number.isFinite(value)) || !vector.some((value) => value !== 0)
  ))) {
    throw new RagError(502, "AI_INVALID_RESPONSE", "The AI service returned an invalid embedding response.");
  }
  return dimensions;
}

function waitWithSignal(promise, signal) {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(new RagError(499, "REQUEST_ABORTED", "The request was cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

// Only vector operations are used after indexing; retain no credential-bearing closures.
const cachedEmbeddings = {
  embedDocuments: async () => { throw new Error('Cached indexes require explicit request embeddings.'); },
  embedQuery: async () => { throw new Error('Cached indexes require explicit request embeddings.'); },
};

/** In-memory, session-scoped PDF indexes. The provider is injected; tests never need an API key. */
export class DocumentStore {
  #provider;
  #parsePdf;
  #limits;
  #now;
  #sessions = new Map();
  #documents = new Map();
  #pendingUploads = 0;
  #timer;
  #closed = false;

  constructor({ provider, parsePdf = defaultParsePdf, limits = {}, now = Date.now } = {}) {
    if (!provider || ["embedDocuments", "embedQuery", "answer"].some((method) => typeof provider[method] !== "function")) {
      throw new TypeError("DocumentStore requires an AI provider.");
    }
    this.#provider = provider;
    this.#parsePdf = parsePdf;
    this.#limits = { ...DEFAULT_LIMITS, ...limits };
    for (const [name, value] of Object.entries(this.#limits)) {
      if (!Number.isSafeInteger(value) || value < (name === "chunkOverlap" ? 0 : 1)) {
        throw new TypeError(`Invalid document store limit: ${name}`);
      }
    }
    if (this.#limits.chunkOverlap >= this.#limits.chunkSize) throw new TypeError("Chunk overlap must be smaller than chunk size.");
    this.#now = now;
    this.#timer = setInterval(() => this.#sweep(), Math.min(60_000, this.#limits.sessionTtlMs));
    this.#timer.unref?.();
  }

  isReady() {
    return !this.#closed && (typeof this.#provider.isReady !== "function" || this.#provider.isReady());
  }

  createSession() {
    this.#assertOpen();
    this.#sweep();
    if (this.#sessions.size >= this.#limits.maxSessions) {
      throw new RagError(429, "SESSION_LIMIT", "The server is busy. Please try again later.");
    }
    const id = randomBytes(32).toString("base64url");
    this.#sessions.set(id, {
      id, lastSeen: this.#now(), documents: new Set(), pendingUploads: 0,
      activeRequests: 0, controller: new AbortController(), inflight: new Map(),
    });
    return id;
  }

  ensureSession(id) {
    this.#getSession(id);
    return id;
  }

  discardEmptySession(id) {
    const session = this.#sessions.get(id);
    if (session && session.documents.size === 0 && session.pendingUploads === 0 && session.activeRequests === 0) {
      this.#removeSession(session);
    }
  }

  list(sessionId) {
    const session = this.#getSession(sessionId);
    return [...session.documents].map((id) => this.#documents.get(id)).filter(Boolean).map(metadata);
  }

  delete(documentId, sessionId) {
    const session = this.#getSession(sessionId);
    const document = this.#ownedDocument(documentId, session.id);
    this.#removeDocument(document);
  }

  async create(buffer, { name = "document.pdf", sessionId, signal, provider = this.#provider, credentialScope = 'server' } = {}) {
    const session = this.#getSession(sessionId);
    throwIfAborted(signal);
    validatePdfBuffer(buffer, this.#limits);
    if (typeof provider.isReady === 'function' && !provider.isReady()) {
      throw new RagError(503, "AI_NOT_CONFIGURED", "The AI service is not configured. Please ask the server owner to add an API key.");
    }
    const safeName = typeof name === "string"
      ? name.replaceAll("\\", "/").split("/").pop().replace(/[\u0000-\u001f\u007f]/g, "").trim()
      : "";
    if (!safeName || safeName.length > 200) throw new RagError(400, "INVALID_FILENAME", "Please use a PDF filename of 1 to 200 characters.");
    const digest = createHash("sha256").update(buffer).digest("hex");
    for (const id of session.documents) {
      const existing = this.#documents.get(id);
      if (existing?.digest === digest && existing.credentialScope === credentialScope) return metadata(existing);
    }
    // Repeated uploads in the same session share work; different sessions never share indexes.
    const inflightKey = `${credentialScope}:${digest}`;
    if (session.inflight.has(inflightKey)) return waitWithSignal(session.inflight.get(inflightKey), signal);
    if (session.documents.size + session.pendingUploads >= this.#limits.maxDocumentsPerSession) {
      throw new RagError(429, "DOCUMENT_LIMIT", "Please remove a document before uploading another PDF.");
    }
    if (this.#documents.size + this.#pendingUploads >= this.#limits.maxDocuments || this.#pendingUploads >= this.#limits.maxConcurrentUploads) {
      throw new RagError(429, "UPLOAD_LIMIT", "The server is processing too many documents. Please try again shortly.");
    }
    session.pendingUploads += 1;
    session.activeRequests += 1;
    this.#pendingUploads += 1;
    const linkedSignal = combineSignals(signal, session.controller.signal);
    const operation = this.#index(buffer, { name: safeName, session, digest, signal: linkedSignal, provider, credentialScope });
    session.inflight.set(inflightKey, operation);
    try {
      return await operation;
    } finally {
      session.inflight.delete(inflightKey);
      session.pendingUploads -= 1;
      session.activeRequests -= 1;
      session.lastSeen = this.#now();
      this.#pendingUploads -= 1;
    }
  }

  async ask({ documentId, sessionId, question, signal, provider = this.#provider, credentialScope = 'server' } = {}) {
    const session = this.#getSession(sessionId);
    const document = this.#ownedDocument(documentId, session.id);
    if (document.credentialScope !== credentialScope) {
      throw new RagError(409, 'AI_KEY_MISMATCH', 'Use the same API key source and key that indexed this PDF, or upload it again with your new key.');
    }
    throwIfAborted(signal);
    if (typeof question !== "string" || !question.trim() || Array.from(question.trim()).length > this.#limits.maxQuestionCharacters) {
      throw new RagError(400, "INVALID_QUESTION", `Please enter a question of 1 to ${this.#limits.maxQuestionCharacters} characters.`);
    }
    if (document.pendingQuestions >= this.#limits.maxPendingQuestions) {
      throw new RagError(429, "QUESTION_LIMIT", "This document already has too many pending questions. Please wait for an answer.");
    }
    document.pendingQuestions += 1;
    session.activeRequests += 1;
    const linkedSignal = combineSignals(signal, document.controller.signal, session.controller.signal);
    const operation = document.queue.then(async () => {
      throwIfAborted(linkedSignal);
      this.#ownedDocument(documentId, session.id);
      return this.#answer(document, question.trim(), linkedSignal, provider);
    });
    const settled = operation.finally(() => {
      document.pendingQuestions -= 1;
      session.activeRequests -= 1;
      session.lastSeen = this.#now();
    });
    // Keep failed calls from poisoning the next queued question.
    document.queue = settled.then(() => undefined, () => undefined);
    return waitWithSignal(settled, linkedSignal);
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    for (const session of this.#sessions.values()) this.#removeSession(session);
  }

  async #index(buffer, { name, session, digest, signal, provider, credentialScope }) {
    const parsed = await this.#parsePdf(buffer, { signal, limits: this.#limits });
    throwIfAborted(signal);
    this.#validateParsed(parsed);
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: this.#limits.chunkSize, chunkOverlap: this.#limits.chunkOverlap });
    const chunks = await splitter.splitDocuments(parsed.pages.filter(({ text }) => text.trim()).map(({ page, text }) => (
      new Document({ pageContent: text, metadata: { page } })
    )));
    if (!chunks.length) throw new RagError(422, "PDF_NO_TEXT", "This PDF has no selectable text. Please use a text PDF or run OCR first.");
    if (chunks.length > this.#limits.maxChunks) throw new RagError(413, "PDF_CHUNK_LIMIT", "The PDF contains too much text. Please upload a smaller PDF.");
    chunks.forEach((chunk, index) => { chunk.metadata.chunk = index; });
    throwIfAborted(signal);
    const vectors = await provider.embedDocuments(chunks.map((chunk) => chunk.pageContent), { signal });
    throwIfAborted(signal);
    const dimensions = validateVectors(vectors, chunks.length);
    // addVectors reuses the single batch above; asking a question never embeds the PDF again.
    const vectorStore = new MemoryVectorStore(cachedEmbeddings);
    await vectorStore.addVectors(vectors, chunks);
    throwIfAborted(signal);
    this.#assertOpen();
    if (!this.#sessions.has(session.id)) throw new RagError(401, "SESSION_EXPIRED", "Your document session has expired. Please upload the PDF again.");
    const document = {
      id: randomUUID(), sessionId: session.id, digest, name, credentialScope,
      pageCount: parsed.pageCount, chunkCount: chunks.length, dimensions, vectorStore,
      history: [], queue: Promise.resolve(), pendingQuestions: 0, controller: new AbortController(),
    };
    this.#documents.set(document.id, document);
    session.documents.add(document.id);
    return metadata(document);
  }

  async #answer(document, question, signal, provider) {
    const history = document.history.map((turn) => ({ ...turn }));
    // A short prior-question window makes follow-ups useful without embedding the whole conversation.
    const retrievalQuery = [...history.slice(-2).map((turn) => turn.question), question].join("\n");
    const vector = await provider.embedQuery(retrievalQuery, { signal });
    throwIfAborted(signal);
    validateVectors([vector], 1, document.dimensions);
    const matches = await document.vectorStore.similaritySearchVectorWithScore(vector, document.chunkCount);
    // Sort here as well: old LangChain releases do not implement a complete tie comparator.
    matches.sort((a, b) => b[1] - a[1] || a[0].metadata.chunk - b[0].metadata.chunk);
    const seen = new Set();
    const sources = matches.filter(([, score]) => Number.isFinite(score) && score > 0).filter(([chunk]) => {
      const key = `${chunk.metadata.page}\n${chunk.pageContent}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, this.#limits.retrievalCount).map(([chunk]) => ({ page: chunk.metadata.page, text: chunk.pageContent }));
    let answer;
    if (!sources.length) {
      answer = "I could not find relevant information in this document. Please ask a question about its contents.";
    } else {
      answer = await provider.answer({ question, context: sources.map((source) => ({ ...source })), history, signal });
    }
    throwIfAborted(signal);
    this.#ownedDocument(document.id, document.sessionId);
    if (typeof answer !== "string" || !answer.trim() || answer.length > this.#limits.maxAnswerCharacters) {
      throw new RagError(502, "AI_INVALID_RESPONSE", "The AI service returned an invalid answer. Please try again.");
    }
    const cleanAnswer = answer.trim();
    document.history.push({ question, answer: cleanAnswer });
    if (document.history.length > this.#limits.maxHistoryTurns) document.history.splice(0, document.history.length - this.#limits.maxHistoryTurns);
    return { answer: cleanAnswer, sources };
  }

  #validateParsed(parsed) {
    if (!parsed || !Number.isInteger(parsed.pageCount) || parsed.pageCount < 1 || !Array.isArray(parsed.pages)) {
      throw new RagError(400, "INVALID_PDF", "The uploaded PDF could not be read.");
    }
    if (parsed.pageCount > this.#limits.maxPages) throw new RagError(413, "PDF_PAGE_LIMIT", "The PDF has too many pages.");
    let characters = 0;
    const pages = new Set();
    for (const item of parsed.pages) {
      if (!Number.isInteger(item?.page) || item.page < 1 || item.page > parsed.pageCount || pages.has(item.page) || typeof item.text !== "string") {
        throw new RagError(400, "INVALID_PDF", "The uploaded PDF could not be read.");
      }
      pages.add(item.page);
      characters += item.text.length;
      if (characters > this.#limits.maxTextCharacters) throw new RagError(413, "PDF_TEXT_LIMIT", "The PDF contains too much text.");
    }
  }

  #assertOpen() {
    if (this.#closed) throw new RagError(503, "STORE_CLOSED", "The server is shutting down. Please try again later.");
  }

  #getSession(id) {
    this.#assertOpen();
    this.#sweep();
    const session = typeof id === "string" && /^[A-Za-z0-9_-]{43}$/.test(id) ? this.#sessions.get(id) : undefined;
    if (!session) throw new RagError(401, "SESSION_EXPIRED", "Your document session has expired. Please upload the PDF again.");
    session.lastSeen = this.#now();
    return session;
  }

  #ownedDocument(id, sessionId) {
    const document = this.#documents.get(id);
    if (!document || document.sessionId !== sessionId) {
      throw new RagError(404, "DOCUMENT_NOT_FOUND", "This document was not found in your session. Please upload it again.");
    }
    return document;
  }

  #sweep() {
    const time = this.#now();
    for (const session of this.#sessions.values()) {
      if (session.activeRequests === 0 && time - session.lastSeen >= this.#limits.sessionTtlMs) this.#removeSession(session);
    }
  }

  #removeDocument(document) {
    document.controller.abort();
    document.history.length = 0;
    document.vectorStore.memoryVectors.length = 0;
    this.#documents.delete(document.id);
    this.#sessions.get(document.sessionId)?.documents.delete(document.id);
  }

  #removeSession(session) {
    session.controller.abort();
    for (const id of session.documents) {
      const document = this.#documents.get(id);
      if (document) this.#removeDocument(document);
    }
    this.#sessions.delete(session.id);
  }
}
