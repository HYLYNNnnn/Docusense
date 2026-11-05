import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { DocumentStore } from './document-store.js';
import { createOpenAIProvider } from './openai-provider.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const provider = createOpenAIProvider();
const store = new DocumentStore({ provider });
const port = Number(process.env.PORT || 5001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
const origins = (process.env.CORS_ORIGINS || `http://localhost:3000,http://127.0.0.1:3000,http://localhost:${port},http://127.0.0.1:${port}`).split(',').map((v) => v.trim()).filter(Boolean);
const app = createApp({ store, provider, staticDir: path.resolve(here, '../build'), corsOrigins: origins });
const server = app.listen(port, process.env.HOST || '127.0.0.1', () => {
  console.log(`DocuSense listening on port ${port}. AI ${provider.configured ? 'configured' : 'not configured; set server/.env OPENAI_API_KEY'}.`);
});
server.requestTimeout = 180_000;
server.headersTimeout = 30_000;
function shutdown() {
  store.close?.();
  server.close();
  const timeout = setTimeout(() => process.exit(0), 5000);
  timeout.unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
