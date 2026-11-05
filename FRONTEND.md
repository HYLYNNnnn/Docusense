# DocuSense frontend

React 18 / Ant Design frontend for per-session PDF document questions.

## Development

Install root dependencies with `npm ci`, run the backend as described in the root README, then run `npm start` here. API requests use `REACT_APP_API_BASE` (default `/api`). The development proxy targets `http://127.0.0.1:5001`; `API_PROXY_TARGET` can override it. No OpenAI key belongs in frontend configuration.

Upload one PDF up to 10 MiB. The backend parses and indexes it before the UI enables questions. Select an uploaded document to keep conversations separate, inspect answer source excerpts, or delete the document and its server context. A session supports up to three documents and expires after 30 idle minutes.

The private document session capability stays in this tab's `sessionStorage` and is sent in the `X-Session-Id` header. Question text is posted as JSON rather than included in a URL. Page refresh can restore available documents; visible conversation cards remain in the current page's memory. The backend owns the document-specific conversation context.

Voice input is optional and uses browser speech APIs. One recording fills the question box; the user explicitly presses Ask. Recognition does not automatically submit or restart, and unsupported or unavailable microphones do not prevent typed questions. Optional speech output can be turned off.

## Verification

`npm test -- --watchAll=false --runInBand` exercises mocked API/session behavior and document UI flows. `CI=true npm run build` creates the production bundle. Tests do not contact a live model or microphone.
