import { createHmac, randomBytes } from 'node:crypto';
import { createOpenAIProvider, ProviderError } from './openai-provider.js';

// Keys are resolved for a single upload/question, never saved in a document index.
export function createAIConnection({ provider, allowUserKeys = false,
  chatModel = process.env.OPENAI_CHAT_MODEL || 'gpt-5.6-terra',
  embeddingModel = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
  providerFactory = createOpenAIProvider } = {}) {
  const salt = randomBytes(32);
  return {
    config: { server_configured: Boolean(provider.configured), user_keys_allowed: allowUserKeys,
      chat_model: chatModel, embedding_model: embeddingModel },
    resolve(req) {
      const source = req.get('X-AI-Key-Source') || 'server';
      const values = req.rawHeaders.filter((_, index) => index % 2 === 0
        && req.rawHeaders[index].toLowerCase() === 'x-openai-api-key');
      if (source === 'server') {
        if (values.length) throw new ProviderError(400, 'INVALID_KEY_SOURCE', 'Do not send a personal key when using the server key.');
        provider.assertConfigured();
        return { provider, credentialScope: 'server' };
      }
      if (source !== 'personal') throw new ProviderError(400, 'INVALID_KEY_SOURCE', 'Choose the server key or your personal API key.');
      if (!allowUserKeys) throw new ProviderError(403, 'PERSONAL_KEYS_DISABLED', 'Personal API keys are not enabled on this server.');
      const apiKey = (req.get('X-OpenAI-Api-Key') || '').trim();
      if (values.length !== 1 || !apiKey) throw new ProviderError(400, 'API_KEY_REQUIRED', 'Enter your OpenAI API key before uploading or asking questions.');
      if (apiKey.length > 1024 || !/^[\x21-\x7e]+$/.test(apiKey) || apiKey.includes(',')) {
        throw new ProviderError(400, 'INVALID_API_KEY', 'Enter a valid OpenAI API key.');
      }
      const credentialScope = createHmac('sha256', salt).update(apiKey).update('\0').update(embeddingModel).digest('hex');
      return { credentialScope, provider: providerFactory({ apiKey, chatModel, embeddingModel }) };
    },
  };
}
