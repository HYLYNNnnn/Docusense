import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AISettings from './AISettings';
import { getAIConfig } from '../api';

jest.mock('../api', () => ({ getAIConfig: jest.fn() }));
beforeEach(() => {
  sessionStorage.clear(); localStorage.clear();
  getAIConfig.mockResolvedValue({ server_configured: false, user_keys_allowed: true,
    chat_model: 'gpt-5.6-terra', embedding_model: 'text-embedding-3-small' });
});

test('personal keys enable paid actions only after entry and are cleared without persistence', async () => {
  const changed = jest.fn();
  const { unmount } = render(<AISettings onChange={changed} />);
  const input = await screen.findByLabelText('OpenAI API key');
  expect(input).toHaveAttribute('type', 'password');
  expect(changed.mock.calls.at(-1)[0].ready).toBe(false);
  fireEvent.change(input, { target: { value: 'test-personal-key' } });
  await waitFor(() => expect(changed.mock.calls.at(-1)[0]).toEqual({ ready: true,
    options: { keySource: 'personal', apiKey: 'test-personal-key' } }));
  expect(JSON.stringify({ ...sessionStorage, ...localStorage })).not.toContain('test-personal-key');
  fireEvent.click(screen.getByRole('button', { name: 'Clear key' }));
  expect(input).toHaveValue('');
  expect(changed.mock.calls.at(-1)[0].ready).toBe(false);
  fireEvent.change(input, { target: { value: 'another-test-key' } });
  unmount();
  render(<AISettings onChange={changed} />);
  expect(await screen.findByLabelText('OpenAI API key')).toHaveValue('');
});

test('disabled personal-key support never exposes an input and failures can be retried', async () => {
  getAIConfig.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce({
    server_configured: false, user_keys_allowed: false, chat_model: 'configured-chat', embedding_model: 'configured-embedding',
  });
  render(<AISettings onChange={jest.fn()} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByText('configured-chat');
  expect(screen.queryByLabelText('OpenAI API key')).not.toBeInTheDocument();
  expect(screen.getByText(/Ask the operator/)).toBeInTheDocument();
});
