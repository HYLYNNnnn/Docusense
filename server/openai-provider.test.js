import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIProvider } from './openai-provider.js';

test('no API key fails before sending a request', async () => {
  let called = false;
  const provider = createOpenAIProvider({ apiKey: '', fetchImpl: () => { called = true; } });
  await assert.rejects(provider.embedQuery('hello'), { status: 503, code: 'AI_NOT_CONFIGURED' });
  assert.equal(called, false);
});
test('batches embeddings, restores input order, and keeps the key in the server request', async () => {
  const calls = [];
  const provider = createOpenAIProvider({ apiKey: 'local-test-key', fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body); calls.push({ url, body, headers: options.headers });
    return Response.json({ data: body.input.map((text, index) => ({ index, embedding: [1, Number(text)] })).reverse() });
  } });
  const result = await provider.embedDocuments(Array.from({ length: 35 }, (_, i) => String(i)));
  assert.equal(calls.length, 2);
  assert.deepEqual(result[34], [1, 34]);
  assert.equal(calls[0].body.encoding_format, 'float');
  assert.equal(calls[0].headers.Authorization, 'Bearer local-test-key');
});
test('rejects malformed, missing, zero, or changing vectors', async (t) => {
  for (const data of [[], [{ index: 2, embedding: [1, 2] }], [{ index: 0, embedding: [0, 0] }], [{ index: 0, embedding: [1, null] }]]) {
    await t.test(JSON.stringify(data), async () => {
      const provider = createOpenAIProvider({ apiKey: 'test', fetchImpl: async () => Response.json({ data }) });
      await assert.rejects(provider.embedQuery('x'), { status: 502 });
    });
  }
  let count = 0;
  const provider = createOpenAIProvider({ apiKey: 'test', fetchImpl: async () => Response.json({ data: [{ index: 0, embedding: ++count === 1 ? [1, 2] : [1] }] }) });
  await provider.embedQuery('x');
  await assert.rejects(provider.embedQuery('y'), { status: 502 });
});
test('chat includes bounded history and page context without enabling storage', async () => {
  let sent;
  const provider = createOpenAIProvider({ apiKey: 'test', fetchImpl: async (url, options) => {
    sent = JSON.parse(options.body); return Response.json({ choices: [{ message: { content: 'From page two. [p. 2]' } }] });
  } });
  const answer = await provider.answer({ question: 'What about it?', context: [{ page: 2, text: 'Useful excerpt.' }], history: Array.from({ length: 8 }, (_, i) => ({ question: `Q${i}`, answer: `A${i}` })) });
  assert.match(answer, /p\. 2/);
  assert.equal(sent.store, false);
  assert.equal(sent.messages.length, 14);
  assert.equal(sent.messages[1].content, 'Q2');
  assert.match(sent.messages[0].content, /untrusted data/);
  assert.match(sent.messages.at(-1).content, /Useful excerpt/);
});
test('upstream errors are sanitized and never invalidate a document session', async (t) => {
  for (const [upstream, expected] of [[401, 503], [403, 503], [429, 429], [500, 502]]) await t.test(String(upstream), async () => {
    const provider = createOpenAIProvider({ apiKey: 'test', fetchImpl: async () => new Response('private provider details', { status: upstream }) });
    await assert.rejects(provider.embedQuery('x'), (error) => error.status === expected && !error.message.includes('private'));
  });
});
test('honors cancellation and rejects empty or invalid chat responses', async () => {
  const controller = new AbortController(); controller.abort(new Error('cancelled locally'));
  const provider = createOpenAIProvider({ apiKey: 'test', fetchImpl: async (url, { signal }) => { signal.throwIfAborted(); } });
  await assert.rejects(provider.embedQuery('x', { signal: controller.signal }), /cancelled locally/);
  const empty = createOpenAIProvider({ apiKey: 'test', fetchImpl: async () => Response.json({ choices: [{ message: { content: '' } }] }) });
  await assert.rejects(empty.answer({ question: 'x', context: [] }), { status: 502 });
});

test('null provider payloads are controlled service errors', async () => {
  for (const payload of [null, { data: [null] }]) {
    const provider = createOpenAIProvider({ apiKey: 'test', fetchImpl: async () => Response.json(payload) });
    await assert.rejects(provider.embedQuery('x'), { status: 502, code: 'AI_UNAVAILABLE' });
  }
  const provider = createOpenAIProvider({ apiKey: 'test', fetchImpl: async () => Response.json(null) });
  await assert.rejects(provider.answer({ question: 'x', context: [] }), { status: 502, code: 'AI_UNAVAILABLE' });
});
