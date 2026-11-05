import React from "react";

function Container({ children }) { return <div>{children}</div>; }
const Layout = Object.assign(Container, { Header: Container, Content: Container });
const Typography = {
  Text: ({ children }) => <span>{children}</span>,
  Title: ({ children, level = 2 }) => React.createElement(`h${level}`, null, children),
};
function Button({ children, onClick, htmlType = "button", disabled, loading, ...props }) {
  return <button type={htmlType} disabled={disabled || loading} onClick={onClick} aria-label={props["aria-label"]}>{children}</button>;
}
function TextArea({ value, onChange, disabled, placeholder, ...props }) {
  return <textarea value={value} onChange={onChange} disabled={disabled} placeholder={placeholder} aria-label={props["aria-label"]} />;
}
function Alert({ message, description, closable, onClose }) {
  return <div role="alert">{message}{description}{closable && <button onClick={onClose}>Close alert</button>}</div>;
}
function Select({ value, options, onChange, disabled, ...props }) {
  return <select value={value || ""} onChange={(event) => onChange(event.target.value)} disabled={disabled} aria-label={props["aria-label"]}>
    {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>;
}
function Popconfirm({ children, onConfirm, disabled }) {
  return React.cloneElement(children, { onClick: disabled ? undefined : onConfirm });
}
function Checkbox({ children, checked, onChange }) {
  return <label><input type="checkbox" checked={checked} onChange={onChange} />{children}</label>;
}
function Dragger({ children, customRequest, disabled, accept }) {
  return <div>{children}<input aria-label="Upload PDF" type="file" accept={accept} disabled={disabled}
    onChange={(event) => customRequest({ file: event.target.files[0], onSuccess() {}, onError() {} })} /></div>;
}
export default { Layout, Typography, Button, Input: { TextArea }, Alert, Select, Popconfirm, Checkbox,
  Space: Container, Empty: ({ description }) => <p>{description}</p>, Spin: () => <span>Loading…</span>, Upload: { Dragger } };
