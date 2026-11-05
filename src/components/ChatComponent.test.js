import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ChatComponent from "./ChatComponent";

jest.mock("antd", () => require("../test/antd").default);
const originalRecognition = window.SpeechRecognition;
const originalWebkit = window.webkitSpeechRecognition;
const originalSynthesis = window.speechSynthesis;
const originalUtterance = window.SpeechSynthesisUtterance;

beforeEach(() => {
  window.SpeechRecognition = undefined;window.webkitSpeechRecognition = undefined;
  window.speechSynthesis = undefined;window.SpeechSynthesisUtterance = undefined;
});
afterAll(() => {
  window.SpeechRecognition = originalRecognition;window.webkitSpeechRecognition = originalWebkit;
  window.speechSynthesis = originalSynthesis;window.SpeechSynthesisUtterance = originalUtterance;
});

test("typed questions work when speech is unavailable and errors remain renderable", async () => {
  const ask = jest.fn().mockRejectedValue(new Error("The PDF has expired"));
  render(<ChatComponent onAsk={ask} />);
  expect(screen.getByRole("button", { name: "Voice input" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Question about your PDF"), { target: { value: "What does it say?" } });
  fireEvent.click(screen.getByRole("button", { name: "Ask" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("The PDF has expired");
  expect(screen.getByLabelText("Question about your PDF")).toHaveValue("What does it say?");
  expect(screen.getByRole("button", { name: "Ask" })).toBeEnabled();
});

test("requires a selected document and prevents duplicate pending submissions", async () => {
  let finish;const ask = jest.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const { rerender } = render(<ChatComponent onAsk={ask} disabled />);
  expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled();
  rerender(<ChatComponent onAsk={ask} />);
  fireEvent.change(screen.getByLabelText("Question about your PDF"), { target: { value: "Question" } });
  fireEvent.click(screen.getByRole("button", { name: "Ask" }));
  fireEvent.click(screen.getByRole("button", { name: "Ask" }));
  expect(ask).toHaveBeenCalledTimes(1);
  await act(async () => { finish("Answer"); });
  expect(screen.getByLabelText("Question about your PDF")).toHaveValue("");
});

test("counts question length using Unicode characters", () => {
  render(<ChatComponent onAsk={jest.fn()} />);
  fireEvent.change(screen.getByLabelText("Question about your PDF"), { target: { value: "😀".repeat(2001) } });
  expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Question about your PDF"), { target: { value: "😀".repeat(2000) } });
  expect(screen.getByRole("button", { name: "Ask" })).toBeEnabled();
});

test("one voice recording fills the question box without submitting or restarting", async () => {
  let recognition;
  window.SpeechRecognition = function() { recognition = this;this.start = jest.fn();this.stop = jest.fn();this.abort = jest.fn(); };
  const ask = jest.fn().mockResolvedValue("Answer");
  const { unmount } = render(<ChatComponent onAsk={ask} />);
  fireEvent.click(screen.getByRole("button", { name: "Voice input" }));
  expect(recognition.start).toHaveBeenCalledTimes(1);
  act(() => { recognition.onresult({ results: [[{ transcript: "A spoken question" }]] });recognition.onend(); });
  expect(screen.getByLabelText("Question about your PDF")).toHaveValue("A spoken question");
  expect(ask).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Ask" }));
  await waitFor(() => expect(ask).toHaveBeenCalledWith("A spoken question"));
  expect(recognition.start).toHaveBeenCalledTimes(1);
  unmount();
});

test("disabling read-aloud while an answer is pending prevents later speech", async () => {
  const speak = jest.fn();window.speechSynthesis = { cancel: jest.fn(), speak };
  window.SpeechSynthesisUtterance = function(text) { this.text = text; };
  let finish;const ask = jest.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  render(<ChatComponent onAsk={ask} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Read answers aloud" }));
  fireEvent.change(screen.getByLabelText("Question about your PDF"), { target: { value: "Question" } });
  fireEvent.click(screen.getByRole("button", { name: "Ask" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Read answers aloud" }));
  await act(async () => { finish("Answer"); });
  expect(speak).not.toHaveBeenCalled();
});

test("microphone failures do not disable typed questions", () => {
  let recognition;
  window.SpeechRecognition = function() { recognition = this;this.start = jest.fn();this.abort = jest.fn(); };
  render(<ChatComponent onAsk={jest.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Voice input" }));
  act(() => recognition.onerror({ error: "not-allowed" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Check microphone permission");
  expect(screen.getByLabelText("Question about your PDF")).toBeEnabled();
});
