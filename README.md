# DocuSense

A PDF question-answering application built with React, Ant Design, Express, LangChain and OpenAI. Upload a text PDF, ask follow-up questions, and inspect the retrieved excerpts and their original page numbers.

## What works

- Per-document PDF parsing, overlapping text chunks and cached in-memory embeddings. Questions reuse the document index.
- Session-isolated documents and conversation context; document selection, duplicate-upload reuse and deletion.
- Retrieval of up to four excerpts, page references and up to six completed conversation turns for follow-ups.
- Optional browser voice input and answer playback. Typed questions work without speech support.
- Bounded PDF workers, upload limits, cancellation, timeouts, capacity limits and controlled API errors.

## Local setup

Use **Node.js 24 LTS** and npm. Run these commands from this repository's root:

```sh
npm ci
npm --prefix server ci
cp server/.env.example server/.env
```

Edit `server/.env` and set your own `OPENAI_API_KEY`. Keep this file private. The frontend does not need an API key. Document excerpts, questions and limited conversation history are sent to OpenAI to provide embeddings and answers.

```sh
npm run dev
```

Open `http://localhost:3000`. The development proxy forwards `/api` requests to `http://127.0.0.1:5001`. If either process fails, stop the development command, resolve the reported error and run it again.

Without a server API key, the page and health endpoint still load; upload and question requests return an explicit 503 configuration error. They do not fabricate model answers.

## Configuration

| Setting | Location | Default |
| --- | --- | --- |
| `OPENAI_API_KEY` | Server only | Required for indexing/questions |
| `OPENAI_CHAT_MODEL` | Server only | `gpt-5.6-terra` |
| `OPENAI_EMBEDDING_MODEL` | Server only | `text-embedding-3-small` |
| `PORT`, `HOST` | Server only | `5001`, `127.0.0.1` |
| `CORS_ORIGINS` | Server only | Local frontend and API origins in the example |
| `REACT_APP_API_BASE` | Optional root `.env` | `/api` |
| `API_PROXY_TARGET` | Optional root `.env`, development only | `http://127.0.0.1:5001` |

The original GPT-3.5 Turbo integration has been replaced: [OpenAI lists GPT-3.5 Turbo as shut down](https://developers.openai.com/api/docs/models/gpt-3.5-turbo). The default model is configurable; [GPT-5.6 Terra supports Chat Completions](https://developers.openai.com/api/docs/models/gpt-5.6-terra). Provider calls use the server's native fetch adapter rather than the old LangChain OpenAI client.

To serve a production frontend and API from one local address:

```sh
npm run build
npm run server
```

Open `http://localhost:5001`. Include your actual browser origin in `CORS_ORIGINS` when changing ports or deployment URLs.

## Docker option

After creating `server/.env`:

```sh
docker compose up --build
```

Open `http://localhost:5001`. The compose port is bound to the local computer. The Docker configuration is provided but has not been executed in this workspace.

## Data lifecycle and limits

PDF text, vectors and conversation context are held **only in server memory**. The uploaded binary PDF is not saved to disk. All session data disappears on restart or after 30 idle minutes. The tab keeps only a random session capability and selected document ID in `sessionStorage`; page refresh restores available documents, while visible chat cards remain in page memory. Do not share the session capability.

Each session supports three documents; one PDF may be at most 10 MiB, 100 pages, 300,000 extracted characters and 500 chunks. There are at most 20 sessions, 30 documents and two concurrent indexing operations per instance. Questions are limited to 2,000 Unicode characters. Paid operations have an instance-wide burst limit of 12 and refill one slot every five seconds. Text extraction runs in a disposable worker with a 20-second deadline. Image-only scanned PDFs require external OCR; password-protected PDFs are not supported.

This is a portfolio/local application with random document sessions, rather than an account system. An internet-facing multi-user deployment also needs account access controls, HTTPS and deployment-specific quotas. In-memory indexes are not shared across instances. PDF text is treated as untrusted context, but generated answers and model-written citations still need human checking; the displayed excerpts are the actual retrieved sources.

## Verification

```sh
npm test -- --watchAll=false --runInBand
npm --prefix server test
CI=true npm run build
```

Tests use synthetic PDFs and local fake model responses. Integration tests exercise the real PDF worker, LangChain vector store, HTTP routes and OpenAI adapter against a local mock upstream. No real OpenAI request, account key or private uploaded PDF is used. Docker and live OpenAI behavior have not been tested.

Frontend details: [FRONTEND.md](FRONTEND.md). API contract: [server/README.md](server/README.md). Repair notes: [修复说明.zh-CN.md](修复说明.zh-CN.md).
