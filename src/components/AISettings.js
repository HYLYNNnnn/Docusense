import React, { useEffect, useState } from 'react';
import { getAIConfig } from '../api';

const controlStyle = { boxSizing: 'border-box', width: '100%', maxWidth: 540, minHeight: 38,
  display: 'block', marginTop: 6, padding: '7px 10px', border: '1px solid #bfbfbf', borderRadius: 6, font: 'inherit' };

export default function AISettings({ disabled = false, onChange }) {
  const [config, setConfig] = useState(null);
  const [source, setSource] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setConfig(null); setError('');
    getAIConfig({ signal: controller.signal }).then((settings) => {
      if (!active) return;
      setConfig(settings);
      setSource(settings.server_configured ? 'server' : settings.user_keys_allowed ? 'personal' : '');
    }).catch((failure) => {
      if (active && failure.name !== 'AbortError') setError('AI settings could not be loaded. Please try again.');
    });
    return () => { active = false; controller.abort(); };
  }, [attempt]);
  const ready = !!config && (source === 'server' ? config.server_configured
    : source === 'personal' && config.user_keys_allowed && !!apiKey.trim());
  useEffect(() => {
    onChange({ ready: !!ready, options: { keySource: source, ...(source === 'personal' ? { apiKey } : {}) } });
  }, [onChange, source, apiKey, ready]);

  return <details open style={{ marginTop: 20, padding: 16, border: '1px solid #d9d9d9', borderRadius: 8, background: '#fafafa' }}>
    <summary style={{ cursor: 'pointer', fontWeight: 600 }}>AI settings</summary>
    {!config && !error && <p role="status">Loading AI settings…</p>}
    {error && <div role="alert"><p>{error}</p><button type="button" onClick={() => setAttempt((value) => value + 1)}>Try again</button></div>}
    {config && <>
      <p>PDF search: <strong>{config.embedding_model}</strong> · Answers: <strong>{config.chat_model}</strong></p>
      {!config.server_configured && !config.user_keys_allowed ? <p>AI is not configured on this site. Ask the operator to enable an API key before uploading PDFs.</p> : <>
        <label>API key source
          <select aria-label="API key source" value={source} disabled={disabled} style={controlStyle}
            onChange={(event) => { setSource(event.target.value); setApiKey(''); }}>
            {config.server_configured && <option value="server">Use DocuSense’s key</option>}
            {config.user_keys_allowed && <option value="personal">Use my API key</option>}
          </select>
        </label>
        {source === 'personal' && <div style={{ marginTop: 14 }}>
          <label>OpenAI API key
            <input aria-label="OpenAI API key" type="password" autoComplete="off" spellCheck={false}
              value={apiKey} disabled={disabled} placeholder="Enter your API key" style={controlStyle}
              onChange={(event) => setApiKey(event.target.value)} />
          </label>
          <button type="button" disabled={!apiKey || disabled} onClick={() => setApiKey('')} style={{ marginTop: 8 }}>Clear key</button>
          <p style={{ maxWidth: 700, marginBottom: 8 }}>Your key stays in this page’s memory until cleared or you leave/refresh. Uploading a PDF or selecting Ask sends it through this DocuSense server to OpenAI; this app does not save it. PDF text, questions, and relevant conversation are sent to OpenAI. Usage is charged to your OpenAI API account.</p>
          <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">Manage OpenAI API keys</a>
          <p>Use the same key for a PDF’s upload and follow-up questions. After refreshing, re-enter that key to continue. Changing keys requires uploading the PDF again.</p>
          {!apiKey.trim() && <p>Enter your API key to enable PDF uploads and questions.</p>}
        </div>}
        {source === 'server' && <p>Uploading indexes your PDF with OpenAI. Questions send retrieved excerpts and recent conversation for an answer.</p>}
      </>}
    </>}
  </details>;
}
