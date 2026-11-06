import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../app.js';
import { DocumentStore } from '../document-store.js';
import { fakeProvider, pdfFixture } from '../test-support/http-fixtures.js';

async function setup(t, allowUserKeys = true) {
  const calls = [];
  const provider = fakeProvider();
  provider.answer = async () => { throw new Error('Must not fall back to server credentials'); };
  const store = new DocumentStore({ provider, parsePdf: async () => ({ pageCount: 1,
    pages: [{ page: 1, text: 'Apples grow on trees in orchards.' }] }) });
  const app = createApp({ store, provider, allowUserKeys, providerFactory: ({ apiKey }) => ({
    ...fakeProvider(),
    async embedDocuments(texts) { calls.push(['index', apiKey]); return texts.map(() => [1, 0.1]); },
    async embedQuery() { calls.push(['query', apiKey]); return [1, 0.1]; },
    async answer() { calls.push(['answer', apiKey]); return 'Apples grow in orchards. [p. 1]'; },
  }) });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    store.close();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const headers = (key, sessionId) => ({ 'X-AI-Key-Source': 'personal',
    ...(key ? { 'X-OpenAI-Api-Key': key } : {}), ...(sessionId ? { 'X-Session-Id': sessionId } : {}) });
  const upload = async (key, sessionId) => {
    const body = new FormData(); body.append('file', new Blob([pdfFixture()], { type: 'application/pdf' }), 'guide.pdf');
    return fetch(base + '/upload', { method: 'POST', body, headers: headers(key, sessionId) });
  };
  const ask = (documentId, sessionId, key, source = 'personal') => fetch(base + '/chat', {
    method: 'POST', headers: { ...headers(key, sessionId), 'X-AI-Key-Source': source, 'Content-Type': 'application/json' },
    body: JSON.stringify({ document_id: documentId, question: 'Where do apples grow?' }),
  });
  return { base, calls, store, headers, upload, ask };
}

test('personal keys require operator opt-in and cannot silently use server credentials', async (t) => {
  const disabled = await setup(t, false);
  const config = await fetch(disabled.base + '/ai-config');
  assert.equal(config.headers.get('cache-control'), 'no-store');
  assert.equal((await config.json()).user_keys_allowed, false);
  assert.equal((await disabled.upload('test-key')).status, 403);
  const enabled = await setup(t);
  assert.equal((await enabled.upload()).status, 400);
  const mixed = await fetch(enabled.base + '/upload', { method: 'POST', headers: {
    'X-OpenAI-Api-Key': 'test-key', 'X-AI-Key-Source': 'server',
  } });
  assert.equal(mixed.status, 400);
  assert.equal(enabled.calls.length, 0);
});

test('indexes are reused only for the same key and follow-ups require matching credentials', async (t) => {
  const { base, calls, upload, ask } = await setup(t);
  const aResponse = await upload('first-test-key');
  assert.equal(aResponse.status, 201);
  const a = await aResponse.json();
  const same = await (await upload('first-test-key', a.session_id)).json();
  assert.equal(same.document.id, a.document.id);
  assert.deepEqual(calls, [['index', 'first-test-key']]);
  const b = await (await upload('second-test-key', a.session_id)).json();
  assert.notEqual(b.document.id, a.document.id);
  assert.equal((await ask(a.document.id, a.session_id, 'second-test-key')).status, 409);
  assert.equal((await ask(a.document.id, a.session_id, undefined, 'server')).status, 409);
  assert.equal(calls.filter(([kind]) => kind === 'query').length, 0);
  const answers = await Promise.all([
    ask(a.document.id, a.session_id, 'first-test-key'),
    ask(b.document.id, a.session_id, 'second-test-key'),
  ]);
  for (const response of answers) {
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.sources[0].page, 1);
    assert.doesNotMatch(JSON.stringify(result), /test-key/);
  }
  for (const key of ['first-test-key', 'second-test-key']) {
    assert.equal(calls.filter(([kind, credential]) => kind === 'index' && credential === key).length, 1);
    assert.equal(calls.filter(([kind, credential]) => kind === 'answer' && credential === key).length, 1);
  }
  const listed = await fetch(base + '/documents', { headers: { 'X-Session-Id': a.session_id } });
  assert.doesNotMatch(await listed.text(), /test-key|credentialScope/);
});

test('config does not expose keys and CORS explicitly permits the personal-key headers', async (t) => {
  const { base } = await setup(t);
  const config = await (await fetch(base + '/ai-config')).json();
  assert.equal(config.user_keys_allowed, true);
  assert.equal(config.embedding_model, 'text-embedding-3-small');
  assert.doesNotMatch(JSON.stringify(config), /apiKey|test-key/);
  const preflight = await fetch(base + '/upload', { method: 'OPTIONS', headers: {
    Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'x-openai-api-key,x-ai-key-source,x-session-id',
  } });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers'), /X-OpenAI-Api-Key/);
});
