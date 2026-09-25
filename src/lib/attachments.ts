export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

// Only these are served inline (rendered in the browser). Everything else — notably
// HTML and SVG, which can carry script — is forced to download, so an uploaded file
// can never run in this app's origin.
const INLINE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
]);

export function downloadPath(issueId: string, attachmentId: string) {
  return `/api/issues/${encodeURIComponent(issueId)}/attachments/${encodeURIComponent(attachmentId)}/download`;
}

/** Content-Disposition with an ASCII fallback plus the RFC 5987 UTF-8 filename. */
export function contentDisposition(fileName: string, mimeType: string) {
  const type = INLINE_MIME_TYPES.has(mimeType) ? "inline" : "attachment";
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** Normalizes a client-supplied MIME type; anything malformed becomes octet-stream. */
export function normalizeMimeType(mimeType: string | undefined) {
  const base = (mimeType ?? "").split(";")[0].trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(base) ? base : "application/octet-stream";
}
