import React, { useEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, Input, Space, Typography } from "antd";
import { MAX_QUESTION_CHARACTERS } from "../api";

function cancelSpeech() {
  try { window.speechSynthesis?.cancel(); } catch { /* Optional browser service. */ }
}

export default function ChatComponent({ onAsk, disabled = false, isLoading = false }) {
  const [question, setQuestion] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [recording, setRecording] = useState(false);
  const [readAloud, setReadAloud] = useState(false);
  const [error, setError] = useState("");
  const recognitionRef = useRef(null);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const readAloudRef = useRef(false);
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const canSpeak = !!window.speechSynthesis && !!window.SpeechSynthesisUtterance;
  const busy = disabled || isLoading || submitting;
  const text = question.trim();
  const length = Array.from(text).length;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (recognitionRef.current) {
        recognitionRef.current.onresult = null;
        recognitionRef.current.onend = null;
        recognitionRef.current.onerror = null;
        try { recognitionRef.current.abort(); } catch { /* Already stopped. */ }
      }
      cancelSpeech();
    };
  }, []);

  useEffect(() => {
    if (disabled || isLoading) {
      try { recognitionRef.current?.abort(); } catch { /* Already stopped. */ }
      recognitionRef.current = null;
      setRecording(false);
    }
  }, [disabled, isLoading]);

  const submit = async (event) => {
    event?.preventDefault();
    if (busy || inFlight.current || !text || length > MAX_QUESTION_CHARACTERS) return;
    inFlight.current = true;
    setSubmitting(true);
    setError("");
    try {
      const answer = await onAsk(text);
      if (!mounted.current) return;
      if (answer) {
        setQuestion("");
        if (readAloudRef.current && canSpeak) {
          try {
            window.speechSynthesis.cancel();
            window.speechSynthesis.speak(new window.SpeechSynthesisUtterance(answer));
          } catch {
            setError("The answer is ready, but spoken output is unavailable.");
          }
        }
      }
    } catch (failure) {
      if (mounted.current) setError(failure.message || "Unable to answer that question. Please try again.");
    } finally {
      inFlight.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };

  const toggleRecording = () => {
    if (recording) {
      try { recognitionRef.current?.stop(); } catch { /* Already stopped. */ }
      setRecording(false);
      return;
    }
    if (!Recognition || busy) return;
    setError("");
    let recognition;
    try { recognition = new Recognition(); }
    catch { setError("Voice input is unavailable. Please type your question."); return; }
    recognitionRef.current = recognition;
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = navigator.language || "en-US";
    recognition.onresult = (event) => {
      if (mounted.current && recognitionRef.current === recognition) {
        setQuestion(Array.from(event.results || []).map((result) => result[0]?.transcript || "").join(" ").trim());
      }
    };
    recognition.onerror = () => {
      if (mounted.current && recognitionRef.current === recognition) {
        setError("Voice input is unavailable. Check microphone permission or type your question.");
        setRecording(false);
        recognitionRef.current = null;
      }
    };
    recognition.onend = () => {
      if (mounted.current && recognitionRef.current === recognition) {
        setRecording(false);
        recognitionRef.current = null;
      }
    };
    try { recognition.start(); setRecording(true); }
    catch { recognitionRef.current = null; setRecording(false); setError("Voice input could not start. Please type your question."); }
  };

  return (
    <form onSubmit={submit}>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      <Input.TextArea aria-label="Question about your PDF" placeholder="Ask a question about the selected PDF"
        value={question} disabled={busy} onChange={(event) => setQuestion(event.target.value)}
        autoSize={{ minRows: 2, maxRows: 6 }} />
      <Space wrap style={{ marginTop: 12 }}>
        <Button type="primary" htmlType="submit" loading={isLoading || submitting}
          disabled={busy || !text || length > MAX_QUESTION_CHARACTERS}>Ask</Button>
        <Button onClick={toggleRecording} disabled={!Recognition || busy} danger={recording}>
          {recording ? "Stop recording" : "Voice input"}
        </Button>
        {canSpeak && <Checkbox checked={readAloud} onChange={(event) => {
          readAloudRef.current = event.target.checked;
          setReadAloud(event.target.checked);
          if (!event.target.checked) cancelSpeech();
        }}>Read answers aloud</Checkbox>}
        <Typography.Text type={length > MAX_QUESTION_CHARACTERS ? "danger" : "secondary"}>
          {length}/{MAX_QUESTION_CHARACTERS} characters
        </Typography.Text>
      </Space>
      {!Recognition && <div><Typography.Text type="secondary">Voice input is not supported in this browser. Typed questions work normally.</Typography.Text></div>}
    </form>
  );
}
