import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';

const MAX_BYTES = 10 * 1024 * 1024;
const asyncRoute = (handler) => (req, res, next) => Promise.resolve().then(() => handler(req, res, next)).catch(next);
function fail(status, code, message) { return Object.assign(new Error(message), { status, code, public: true }); }
const publicMetadata = ({ id, name, pageCount, chunkCount }) => ({ id, name, page_count: pageCount, chunk_count: chunkCount });
const sessionToken = /^[A-Za-z0-9_-]{43}$/;
const safeName = (name) => (String(name || 'document.pdf').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120) || 'document.pdf');

export function createApp({ store, provider, staticDir, corsOrigins = ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5001', 'http://127.0.0.1:5001'], requestTimeoutMs = 150_000, maxConcurrentUploads = 2 } = {}) {
  if (!store || !provider) throw new Error('A document store and AI provider are required.');
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); next();
  });
  app.use(cors({ origin(origin, done) {
    if (!origin || corsOrigins.includes(origin)) return done(null, true);
    return done(fail(403, 'ORIGIN_REJECTED', 'This origin is not allowed.'));
  }, methods: ['GET', 'POST', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'X-Session-Id'] }));
  app.use(express.json({ limit: '16kb', strict: true }));
  const router = express.Router();
  // Bound paid work per running instance as well as limiting concurrent PDF indexing.
  let workTokens = 12;
  let lastRefill = Date.now();
  function allowAIWork() {
    const now = Date.now();
    workTokens = Math.min(12, workTokens + (now - lastRefill) / 5000);
    lastRefill = now;
    if (workTokens < 1) throw fail(429, 'AI_WORK_LIMIT', 'The server is busy. Please wait a few seconds and try again.');
    workTokens--;
  }
  router.get('/health', (req, res) => res.json({ status: 'ok', ai_configured: Boolean(provider.configured) }));
  function session(req, required = true) {
    const token = req.get('X-Session-Id');
    if (!token && !required) return null;
    if (!token || !sessionToken.test(token)) throw fail(401, 'SESSION_EXPIRED', 'Your document session has expired. Upload your PDF again.');
    store.ensureSession(token); return token;
  }
  function timed(handler) {
    return asyncRoute(async (req, res) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(fail(504, 'REQUEST_TIMEOUT', 'The document request timed out. Please try again.')), requestTimeoutMs);
      const cancel = () => { if (!res.writableEnded) controller.abort(fail(499, 'REQUEST_CANCELLED', 'Request cancelled.')); };
      req.once('aborted', cancel); res.once('close', cancel);
      let onAbort;
      const aborted = new Promise((resolve, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      try { await Promise.race([handler(req, res, controller.signal), aborted]); }
      catch (error) { throw controller.signal.aborted ? controller.signal.reason : error; }
      finally {
        clearTimeout(timer); req.off('aborted', cancel); res.off('close', cancel);
        controller.signal.removeEventListener('abort', onAbort);
      }
    });
  }
  let activeUploads = 0;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1, fields: 0, parts: 1, fieldNameSize: 64, headerPairs: 100 } }).single('file');
  router.post('/upload', asyncRoute(async (req, res, next) => {
    provider.assertConfigured();
    const token = session(req, false);
    if (activeUploads >= maxConcurrentUploads) throw fail(429, 'UPLOAD_BUSY', 'The server is processing other PDFs. Please try again shortly.');
    allowAIWork();
    activeUploads++;
    let released = false;
    const release = () => { if (!released) { activeUploads--; released = true; } };
    res.once('close', release);
    upload(req, res, (error) => {
      if (error) { release(); return next(error); }
      timed(async (request, response, signal) => {
        try {
          if (!request.file) throw fail(400, 'PDF_REQUIRED', 'Choose one PDF document.');
          const { buffer, originalname, mimetype } = request.file;
          if (!buffer.length) throw fail(400, 'PDF_REQUIRED', 'Choose a nonempty PDF document.');
          if (!/\.pdf$/i.test(originalname) || !['application/pdf', 'application/octet-stream'].includes(mimetype)
              || !buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw fail(415, 'INVALID_PDF', 'Only PDF documents are supported.');
          const sessionId = token || store.createSession();
          try {
            const metadata = await store.create(buffer, { name: safeName(originalname), sessionId, signal });
            if (!signal.aborted) response.status(201).json({ document: publicMetadata(metadata), session_id: sessionId });
          } catch (error) {
            if (!token) store.discardEmptySession?.(sessionId);
            throw error;
          }
        } finally { request.file = undefined; release(); }
      })(req, res, next);
    });
  }));
  router.get('/documents', asyncRoute(async (req, res) => {
    const id = session(req); res.json({ documents: store.list(id).map(publicMetadata), session_id: id });
  }));
  router.delete('/documents/:id', asyncRoute(async (req, res) => { store.delete(req.params.id, session(req)); res.status(204).end(); }));
  router.post('/chat', timed(async (req, res, signal) => {
    const sessionId = session(req); const body = req.body;
    if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some((key) => !['document_id', 'question', 'session_id'].includes(key))
        || (body.session_id !== undefined && body.session_id !== sessionId)
        || typeof body.document_id !== 'string' || !body.document_id || body.document_id.length > 100
        || typeof body.question !== 'string' || !body.question.trim() || Array.from(body.question.trim()).length > 2000) {
      throw fail(400, 'INVALID_QUESTION', 'Select a PDF and ask a question using 1–2000 characters.');
    }
    provider.assertConfigured();
    allowAIWork();
    const result = await store.ask({ documentId: body.document_id, sessionId, question: body.question.trim(), signal });
    if (!signal.aborted) res.json({ ...result, document_id: body.document_id, session_id: sessionId });
  }));
  app.use('/api', router); app.use('/', router);
  app.use('/api', (req, res) => res.status(404).json({ code: 'NOT_FOUND', message: 'API route not found.' }));
  if (staticDir && fs.existsSync(path.join(staticDir, 'index.html'))) {
    app.use(express.static(staticDir, { index: false, dotfiles: 'deny' }));
    app.get('*', (req, res, next) => {
      if (path.extname(req.path) || !req.accepts('html')) return next();
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }
  app.use((req, res) => res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found.' }));
  app.use((error, req, res, next) => {
    if (res.headersSent || res.destroyed) return next(error);
    if (error instanceof multer.MulterError) {
      const tooLarge = error.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({ code: tooLarge ? 'PDF_TOO_LARGE' : 'INVALID_UPLOAD', message: tooLarge ? 'PDF documents must be no larger than 10 MiB.' : 'Upload exactly one PDF in the file field, without extra fields.' });
    }
    if (error.type === 'entity.too.large') return res.status(413).json({ code: 'BODY_TOO_LARGE', message: 'The request is too large.' });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ code: 'INVALID_JSON', message: 'Send valid JSON.' });
    const known = error.public === true && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,60}$/.test(error.code);
    const status = known && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
    const safeServerErrors = {
      AI_NOT_CONFIGURED: 'Set OPENAI_API_KEY on the server before uploading or asking questions.',
      AI_AUTH_ERROR: 'The server AI credentials are unavailable. Please check the server configuration.',
      AI_UNAVAILABLE: 'The AI service is unavailable. Please try again.', AI_TIMEOUT: 'The AI service timed out. Please try again.',
      REQUEST_TIMEOUT: 'The document request timed out. Please try again.',
    };
    res.status(status).json({ code: known ? error.code : 'INTERNAL_ERROR', message: status >= 500 ? (safeServerErrors[error.code] || 'The document service is unavailable. Please try again.') : (known ? error.message : 'The request failed.') });
  });
  return app;
}
