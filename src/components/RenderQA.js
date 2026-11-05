import React from "react";
import { Spin, Typography } from "antd";

export default function RenderQA({ conversation = [], isLoading = false }) {
  return (
    <>
      {conversation.map((entry, index) => (
        <article key={entry.id || index} style={{ marginBottom: 24 }}>
          <div style={{ textAlign: "right" }}>
            <p style={{ display: "inline-block", maxWidth: "90%", textAlign: "left", background: "#1677ff", color: "white", padding: 12, borderRadius: 10, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{entry.question}</p>
          </div>
          <div style={{ background: "#f5f5fa", padding: 12, borderRadius: 10, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{entry.answer}</div>
          {entry.sources?.length > 0 && <details style={{ marginTop: 8 }}>
            <summary>Source excerpts ({entry.sources.length})</summary>
            {entry.sources.map((source, sourceIndex) => (
              <blockquote key={sourceIndex} style={{ borderLeft: "3px solid #d9d9d9", paddingLeft: 12, margin: "12px 0" }}>
                <Typography.Text strong>{Number.isInteger(source.page) ? `Page ${source.page}` : "Document excerpt"}</Typography.Text>
                <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{source.text}</p>
              </blockquote>
            ))}
          </details>}
        </article>
      ))}
      {isLoading && <div role="status"><Spin /> Searching this PDF and preparing an answer…</div>}
    </>
  );
}
