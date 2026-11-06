# DocuSense API

Run with Node.js 24: install this directory's dependencies with `npm ci`, copy `.env.example` to `.env`, set `OPENAI_API_KEY`, and run `npm start`. The root `npm run dev` command starts both development processes. The server uses native fetch for OpenAI and LangChain for chunking and the in-memory vector store.

All routes accept the `/api` prefix. Unprefixed equivalents exist for the development proxy. Errors use JSON `{ "code": "ERROR_CODE", "message": "Readable description" }`. Questions are submitted in the body, never a query string. API responses use `Cache-Control: no-store`.

| Method | Route | Request | Response |
| --- | --- | --- | --- |
| GET | `/api/health` | None | `{status, ai_configured}` |
| GET | `/api/ai-config` | None | `{server_configured,user_keys_allowed,chat_model,embedding_model}`; no credentials |
| POST | `/api/upload` | Multipart field `file`, exactly one PDF, no extra fields | 201 `{document:{id,name,page_count,chunk_count},session_id}` |
| GET | `/api/documents` | `X-Session-Id` header | `{documents:[...],session_id}` |
| POST | `/api/chat` | Header plus JSON `{document_id,question,session_id?}` | `{answer,sources:[{page,text}],document_id,session_id}` |
| DELETE | `/api/documents/:id` | Header | 204 |

The first successful upload creates a cryptographically random session capability. Subsequent operations send it in `X-Session-Id`. A supplied invalid capability is never silently replaced. The optional body session must match the header. Unknown or expired sessions return 401; unknown and cross-session documents return the same 404. Sessions are tab capabilities, not user accounts.

Repeating the same binary PDF in one session with the same credential scope returns the original document and keeps its history; different keys or sessions never share an index. Deletion clears vectors/history and cancels pending questions. Failed initial uploads release their unused session reservation. Session expiry and server restart require a new upload.

For upload/chat, `X-AI-Key-Source` selects `server` (default) or `personal`. Personal requests need `ALLOW_USER_API_KEYS=true` and one `X-OpenAI-Api-Key` header. A missing personal key is rejected without falling back to server credentials; server-mode requests carrying a personal key are also rejected. The request-local provider calls the fixed OpenAI endpoint with redirects disabled. Keys are never added to responses, document records, or persistent storage; the cached vector store retains no credential-bearing provider closures. A keyed fingerprint scopes the index, and asking with another key/source returns `409 AI_KEY_MISMATCH`. List/delete require only the document session capability.

Supported inputs are text PDFs, including Unicode text when encoded in the document. Image-only scans return 422 with an OCR explanation; encrypted PDFs return 422. Invalid PDFs return 400/415, oversized inputs return 413, capacity/provider throttling returns 429, absent/invalid AI configuration returns 503, and upstream/overall timeouts return 504. Raw provider errors, keys and local paths are not returned.

PDF extraction runs in a worker with bounded heap, deadline and output size. Evaluation, XFA, WASM and external fetches are disabled; only PDF.js's packaged font/CMap files may be loaded. No upload directory or PDF download route is exposed. Limits and lifecycle details are in the root README.

`npm test` runs unit and local HTTP integration tests. Provider credentials in tests are clearly fake, and the local mock does not contact OpenAI. The `baseURL` injection is a constructor option for tests, not a public endpoint or environment setting.
