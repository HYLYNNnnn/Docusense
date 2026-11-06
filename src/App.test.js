import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "./App";
import {
  askQuestion, deleteDocument, getSelectedDocumentId, getSessionId,
  listDocuments, SESSION_EXPIRED_EVENT, uploadDocument,
  getAIConfig,
} from "./api";

jest.mock("antd", () => require("./test/antd").default);
jest.mock("./api", () => ({
  MAX_QUESTION_CHARACTERS: 2000,
  SESSION_EXPIRED_EVENT: "docusense:session-expired",
  getSessionId: jest.fn(), getSelectedDocumentId: jest.fn(), rememberSelectedDocument: jest.fn(),
  listDocuments: jest.fn(), uploadDocument: jest.fn(), askQuestion: jest.fn(), deleteDocument: jest.fn(),
  getAIConfig: jest.fn(),
}));

const first = { id: "doc-a", name: "First.pdf", page_count: 2, chunk_count: 3 };
const second = { id: "doc-b", name: "Second.pdf", page_count: 4, chunk_count: 5 };

beforeEach(() => {
  getAIConfig.mockResolvedValue({ server_configured: true, user_keys_allowed: true,
    chat_model: 'gpt-5.6-terra', embedding_model: 'text-embedding-3-small' });
  getSessionId.mockReturnValue(null);
  getSelectedDocumentId.mockReturnValue("");
  listDocuments.mockResolvedValue({ documents: [] });
  uploadDocument.mockResolvedValue({ document: first, session_id: "session" });
  deleteDocument.mockResolvedValue(undefined);
  askQuestion.mockResolvedValue({ answer: "Document answer", sources: [{ page: 2, text: "Source excerpt" }] });
});

async function restore(documents = [first, second], selected = first.id) {
  getSessionId.mockReturnValue("session");
  getSelectedDocumentId.mockReturnValue(selected);
  listDocuments.mockResolvedValue({ documents });
  render(<App />);
  await screen.findByLabelText("Current PDF");
}

function ask(question) {
  fireEvent.change(screen.getByLabelText("Question about your PDF"), { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: "Ask" }));
}

test("uploads a PDF and enables questions only after indexing succeeds", async () => {
  render(<App />);
  await screen.findByText('gpt-5.6-terra');
  expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled();
  const file = new File(["%PDF content"], "First.pdf", { type: "application/pdf" });
  fireEvent.change(screen.getByLabelText("Upload PDF"), { target: { files: [file] } });
  expect(await screen.findByLabelText("Current PDF")).toHaveValue(first.id);
  expect(uploadDocument).toHaveBeenCalledWith(file, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(screen.getByLabelText("Question about your PDF")).toBeEnabled();
  ask("What is in the document?");
  expect(await screen.findByText("Document answer")).toBeInTheDocument();
  expect(screen.getByText("Source excerpt")).toBeInTheDocument();
  expect(screen.getByText("Page 2")).toBeInTheDocument();
});

test("restores the selected PDF and keeps each document's chat separate", async () => {
  await restore([first, second], second.id);
  expect(screen.getByLabelText("Current PDF")).toHaveValue(second.id);
  ask("Question for second");
  expect(await screen.findByText("Document answer")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Current PDF"), { target: { value: first.id } });
  expect(screen.queryByText("Document answer")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Current PDF"), { target: { value: second.id } });
  expect(screen.getByText("Document answer")).toBeInTheDocument();
  expect(askQuestion).toHaveBeenCalledWith(second.id, "Question for second", expect.any(Object));
});

test("switching PDFs aborts pending chat and ignores a late answer", async () => {
  let finish;
  askQuestion.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await restore();
  ask("Question for first");
  const signal = askQuestion.mock.calls[0][2].signal;
  fireEvent.change(screen.getByLabelText("Current PDF"), { target: { value: second.id } });
  expect(signal.aborted).toBe(true);
  await act(async () => { finish({ answer: "Old PDF's late answer", sources: [] }); });
  expect(screen.queryByText("Old PDF's late answer")).not.toBeInTheDocument();
  ask("Question for second");
  expect(await screen.findByText("Document answer")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Current PDF"), { target: { value: first.id } });
  expect(screen.queryByText("Old PDF's late answer")).not.toBeInTheDocument();
});

test("a failed upload preserves the current document and shows a readable error", async () => {
  await restore();
  uploadDocument.mockRejectedValueOnce(new Error("This PDF does not contain readable text"));
  fireEvent.change(screen.getByLabelText("Upload PDF"), {
    target: { files: [new File(["%PDF"], "Scanned.pdf", { type: "application/pdf" })] },
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("This PDF does not contain readable text");
  expect(screen.getByLabelText("Current PDF")).toHaveValue(first.id);
  expect(screen.getByLabelText("Question about your PDF")).toBeEnabled();
});

test("deleting PDFs removes their context and disables questions after the last PDF", async () => {
  await restore();
  fireEvent.click(screen.getByRole("button", { name: "Delete PDF" }));
  await waitFor(() => expect(screen.getByLabelText("Current PDF")).toHaveValue(second.id));
  expect(deleteDocument).toHaveBeenCalledWith(first.id);
  fireEvent.click(screen.getByRole("button", { name: "Delete PDF" }));
  await waitFor(() => expect(screen.queryByLabelText("Current PDF")).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled();
});

test("expired sessions clear the selected PDF and conversation", async () => {
  await restore();
  ask("Question");
  await screen.findByText("Document answer");
  act(() => window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT)));
  expect(screen.getByRole("alert")).toHaveTextContent("session has expired");
  expect(screen.queryByLabelText("Current PDF")).not.toBeInTheDocument();
  expect(screen.queryByText("Document answer")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled();
});

test("re-uploading an indexed PDF preserves its displayed conversation", async () => {
  await restore();
  ask("Remember this answer");
  await screen.findByText("Document answer");
  fireEvent.change(screen.getByLabelText("Upload PDF"), {
    target: { files: [new File(["%PDF same"], "First.pdf", { type: "application/pdf" })] },
  });
  await waitFor(() => expect(uploadDocument).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByLabelText("Upload PDF")).toBeEnabled());
  expect(screen.getByText("Document answer")).toBeInTheDocument();
  expect(within(screen.getByLabelText('Current PDF')).getAllByRole("option")).toHaveLength(2);
});

test("blocks a fourth document until one is deleted", async () => {
  await restore([first, second, { ...first, id: "doc-c", name: "Third.pdf" }]);
  expect(screen.getByLabelText("Upload PDF")).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("Delete one before uploading another");
});

test('personal keys gate uploads and questions and are passed only to the paid operations', async () => {
  getAIConfig.mockResolvedValue({ server_configured: false, user_keys_allowed: true,
    chat_model: 'gpt-5.6-terra', embedding_model: 'text-embedding-3-small' });
  render(<App />);
  const input = await screen.findByLabelText('OpenAI API key');
  expect(screen.getByLabelText('Upload PDF')).toBeDisabled();
  fireEvent.change(input, { target: { value: 'test-personal-key' } });
  await waitFor(() => expect(screen.getByLabelText('Upload PDF')).toBeEnabled());
  fireEvent.change(screen.getByLabelText('Upload PDF'), {
    target: { files: [new File(['%PDF test'], 'First.pdf', { type: 'application/pdf' })] },
  });
  await screen.findByLabelText('Current PDF');
  expect(uploadDocument.mock.calls[0][1]).toMatchObject({ keySource: 'personal', apiKey: 'test-personal-key' });
  ask('What is in the PDF?');
  await screen.findByText('Document answer');
  expect(askQuestion.mock.calls[0][2]).toMatchObject({ keySource: 'personal', apiKey: 'test-personal-key' });
  fireEvent.click(screen.getByRole('button', { name: 'Clear key' }));
  expect(screen.getByLabelText('Question about your PDF')).toBeDisabled();
  expect(screen.getByLabelText('Current PDF')).toHaveValue(first.id);
});
