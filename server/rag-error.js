export class RagError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "RagError";
    this.status = status;
    this.code = code;
    this.public = true;
  }
}

export function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new RagError(499, "REQUEST_ABORTED", "The request was cancelled.");
  }
}

export function combineSignals(...signals) {
  const active = signals.filter(Boolean);
  return active.length ? AbortSignal.any(active) : undefined;
}
