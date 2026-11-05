import React from "react";
import { InboxOutlined } from "@ant-design/icons";
import { Upload } from "antd";

export default function PdfUploader({ onUpload, uploading = false, disabled = false }) {
  const customRequest = ({ file, onSuccess, onError }) => {
    let cancelled = false;
    Promise.resolve().then(() => onUpload(file))
      .then((result) => { if (!cancelled) onSuccess?.(result); })
      .catch((error) => { if (!cancelled) onError?.(error); });
    return { abort: () => { cancelled = true; } };
  };
  return (
    <Upload.Dragger name="file" accept=".pdf,application/pdf" multiple={false} maxCount={1}
      disabled={disabled || uploading} showUploadList={false} customRequest={customRequest}>
      <p className="ant-upload-drag-icon"><InboxOutlined /></p>
      <p className="ant-upload-text">Click or drag one PDF here</p>
      <p className="ant-upload-hint">Up to 10 MiB. Select a document below to keep each conversation separate.</p>
    </Upload.Dragger>
  );
}
