import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Empty, Layout, Popconfirm, Select, Space, Spin, Typography } from "antd";
import PdfUploader from "./components/PdfUploader";
import ChatComponent from "./components/ChatComponent";
import RenderQA from "./components/RenderQA";
import {
  askQuestion, deleteDocument, getSelectedDocumentId, getSessionId, listDocuments,
  rememberSelectedDocument, SESSION_EXPIRED_EVENT, uploadDocument,
} from "./api";

const { Header, Content } = Layout;
const { Title, Text } = Typography;

export default function App() {
  const [documents, setDocuments] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [conversations, setConversations] = useState({});
  const [restoring, setRestoring] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [chatting, setChatting] = useState(false);
  const [error, setError] = useState("");
  const requestVersion = useRef(0);
  const chatController = useRef(null);
  const uploadController = useRef(null);
  const mounted = useRef(false);
  const selected = documents.find((document) => document.id === selectedId);

  const cancelChat = useCallback(() => {
    requestVersion.current += 1;
    chatController.current?.abort();
    chatController.current = null;
    setChatting(false);
  }, []);

  const selectDocument = useCallback((id) => {
    cancelChat();
    setSelectedId(id);
    rememberSelectedDocument(id);
    setError("");
  }, [cancelChat]);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const onExpired = () => {
      cancelChat();
      setDocuments([]);
      setSelectedId("");
      setConversations({});
      setError("Your document session has expired. Upload a PDF to start again.");
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    async function restore() {
      try {
        if (!getSessionId()) return;
        const { documents: saved } = await listDocuments({ signal: controller.signal });
        if (controller.signal.aborted) return;
        setDocuments(saved);
        const previous = getSelectedDocumentId();
        const id = saved.some((document) => document.id === previous) ? previous : saved[0]?.id || "";
        setSelectedId(id);
        rememberSelectedDocument(id);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure.message);
      } finally {
        if (!controller.signal.aborted) setRestoring(false);
      }
    }
    restore();
    return () => {
      mounted.current = false;
      controller.abort();
      chatController.current?.abort();
      uploadController.current?.abort();
      requestVersion.current += 1;
      window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
    };
  }, [cancelChat]);

  const handleUpload = async (file) => {
    if (uploadController.current) throw new Error("Please wait for the current PDF to finish indexing.");
    cancelChat();
    setUploading(true);
    setError("");
    const controller = new AbortController();
    uploadController.current = controller;
    try {
      const result = await uploadDocument(file, { signal: controller.signal });
      if (controller.signal.aborted || !mounted.current) return;
      const document = result.document;
      setDocuments((current) => [...current.filter((item) => item.id !== document.id), document]);
      setConversations((current) => ({ ...current, [document.id]: current[document.id] || [] }));
      selectDocument(document.id);
      return document;
    } catch (failure) {
      if (!controller.signal.aborted && mounted.current) setError(failure.message);
      throw failure;
    } finally {
      if (mounted.current && uploadController.current === controller) {
        uploadController.current = null;
        setUploading(false);
      }
    }
  };

  const handleAsk = async (question) => {
    if (!selectedId || uploading || deleting || chatController.current) return null;
    const documentId = selectedId;
    const version = ++requestVersion.current;
    const controller = new AbortController();
    chatController.current = controller;
    setChatting(true);
    try {
      const response = await askQuestion(documentId, question, { signal: controller.signal });
      if (!mounted.current || controller.signal.aborted || version !== requestVersion.current) return null;
      setConversations((current) => ({ ...current, [documentId]: [
        ...(current[documentId] || []), { id: version, question: question.trim(), answer: response.answer, sources: response.sources },
      ] }));
      return response.answer;
    } catch (failure) {
      if (controller.signal.aborted || version !== requestVersion.current) return null;
      throw failure;
    } finally {
      if (mounted.current && version === requestVersion.current) {
        chatController.current = null;
        setChatting(false);
      }
    }
  };

  const handleDelete = async () => {
    if (!selectedId || uploading || chatting) return;
    const id = selectedId;
    cancelChat();
    setDeleting(true);
    setError("");
    try {
      await deleteDocument(id);
      if (!mounted.current) return;
      const remaining = documents.filter((document) => document.id !== id);
      setDocuments(remaining);
      setConversations((current) => { const copy = { ...current }; delete copy[id]; return copy; });
      selectDocument(remaining[0]?.id || "");
    } catch (failure) {
      if (mounted.current) setError(failure.message);
    } finally {
      if (mounted.current) setDeleting(false);
    }
  };

  return (
    <Layout style={{ minHeight: "100vh", background: "white" }}>
      <Header style={{ display: "flex", alignItems: "center", padding: "0 24px", height: "auto", minHeight: 64 }}>
        <Title level={2} style={{ color: "white", margin: 0 }}>DocuSense</Title>
      </Header>
      <Content style={{ width: "100%", maxWidth: 1000, margin: "0 auto", padding: "24px", boxSizing: "border-box" }}>
        <Text>Upload a PDF, then ask questions grounded in that document.</Text>
        {error && <Alert style={{ marginTop: 16 }} type="error" showIcon message={error} closable onClose={() => setError("")} />}
        {restoring ? <div role="status" style={{ padding: 24 }}><Spin /> Restoring your documents…</div> : (
          <>
            <div style={{ margin: "20px 0" }}>
              <PdfUploader onUpload={handleUpload} uploading={uploading} disabled={deleting || documents.length >= 3} />
            </div>
            {uploading && <div role="status">Reading and indexing your PDF…</div>}
            {documents.length >= 3 && <Alert type="info" message="This session has three PDFs. Delete one before uploading another." style={{ marginBottom: 16 }} />}
            {documents.length > 0 && <Space wrap style={{ marginBottom: 16, width: "100%" }}>
              <Select aria-label="Current PDF" value={selectedId || undefined}
                options={documents.map((document) => ({ value: document.id, label: document.name }))}
                onChange={selectDocument} disabled={uploading || deleting} style={{ minWidth: 220, maxWidth: "100%" }} />
              <Popconfirm title="Delete this PDF and its chat context?" onConfirm={handleDelete} disabled={uploading || deleting || chatting}>
                <Button danger loading={deleting} disabled={!selected || uploading || chatting}>Delete PDF</Button>
              </Popconfirm>
              {selected && <Text type="secondary">{selected.page_count} pages · {selected.chunk_count} text chunks</Text>}
            </Space>}
            {!selected ? <Empty description="Upload a PDF to start asking questions." /> : <>
              <Title level={4}>{selected.name}</Title>
              <div aria-live="polite" style={{ minHeight: 160, marginBottom: 24 }}>
                <RenderQA conversation={conversations[selectedId] || []} isLoading={chatting} />
              </div>
            </>}
            <ChatComponent key={selectedId || "no-document"} onAsk={handleAsk}
              disabled={!selected || uploading || deleting} isLoading={chatting} />
          </>
        )}
      </Content>
    </Layout>
  );
}
