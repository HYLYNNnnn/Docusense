import { randomBytes, randomUUID } from "node:crypto";
import { RagError } from "../rag-error.js";

export function pdfFixture(text = "DocuSense HTTP test document.") {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let contents = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(contents));
    contents += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(contents);
  contents += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    contents += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  contents += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(contents);
}

export function fakeProvider({ configured = true } = {}) {
  return {
    configured,
    assertConfigured() {
      if (!this.configured) {
        throw new RagError(503, "AI_NOT_CONFIGURED", "The AI service is not configured.");
      }
    },
    async embedDocuments(texts) {
      this.assertConfigured();
      return texts.map(() => [1, 0, 0]);
    },
    async embedQuery() {
      this.assertConfigured();
      return [1, 0, 0];
    },
    async answer() {
      this.assertConfigured();
      return "The answer is in the uploaded document.";
    },
  };
}

// This fake checks HTTP routing and session ownership. Embedding reuse is tested
// against the real DocumentStore in its own tests.
export class FakeStore {
  constructor(provider) {
    this.provider = provider;
    this.sessions = new Set();
    this.documents = new Map();
    this.calls = { create: [], ask: [] };
    this.askError = null;
  }

  isReady() {
    return this.provider.configured;
  }

  createSession() {
    const sessionId = randomBytes(32).toString("base64url");
    this.sessions.add(sessionId);
    return sessionId;
  }

  ensureSession(sessionId) {
    if (!this.sessions.has(sessionId)) {
      throw new RagError(401, "SESSION_EXPIRED", "Please upload your document again.");
    }
    return sessionId;
  }

  async create(buffer, { name, sessionId, signal }) {
    this.provider.assertConfigured();
    this.ensureSession(sessionId);
    const document = { id: randomUUID(), name, pageCount: 1, chunkCount: 1 };
    this.calls.create.push({ buffer, name, sessionId, signal });
    this.documents.set(document.id, { document, sessionId });
    return { ...document };
  }

  list(sessionId) {
    this.ensureSession(sessionId);
    return [...this.documents.values()]
      .filter((entry) => entry.sessionId === sessionId)
      .map((entry) => ({ ...entry.document }));
  }

  find(documentId, sessionId) {
    this.ensureSession(sessionId);
    const entry = this.documents.get(documentId);
    if (!entry || entry.sessionId !== sessionId) {
      throw new RagError(404, "DOCUMENT_NOT_FOUND", "The document was not found.");
    }
    return entry.document;
  }

  delete(documentId, sessionId) {
    this.find(documentId, sessionId);
    this.documents.delete(documentId);
  }

  async ask({ documentId, sessionId, question, signal }) {
    this.find(documentId, sessionId);
    if (this.askError) throw this.askError;
    this.calls.ask.push({ documentId, sessionId, question, signal });
    return {
      answer: "The answer is in the uploaded document.",
      sources: [{ page: 1, text: "DocuSense HTTP test document." }],
    };
  }
}
