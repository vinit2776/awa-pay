// {prefix}/{fileId}.{ext} — no departmentId prefix. fileId is a server-
// generated UUIDv4, not client input, so the key is already collision-
// proof and non-enumerable on its own; the real traceability path is
// storageKey -> fileId -> request_file.id -> request_file.request_id ->
// request.ref (or, for a vendor document, -> vendor_document.id ->
// vendor_document.vendor_id), a one-hop DB lookup once the row is
// inserted. A department prefix would need the department chosen before
// the first file attach and would go stale if it changed afterward — not
// worth that ordering constraint for a convenience an auditor can get via
// one join anyway.
//
// The prefix itself is a small fixed set (bills, vendor-documents), not
// client-supplied — every UploadPrefix-typed value used across the app is
// a literal, so the key namespace can't be widened by a caller passing an
// arbitrary string.
export type UploadPrefix = "bills" | "vendor-documents";

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "application/pdf": "pdf",
};

export const ALLOWED_MIME_TYPES = Object.keys(MIME_EXTENSIONS);

export function extensionForMime(mime: string): string | null {
  return MIME_EXTENSIONS[mime] ?? null;
}

export function buildStorageKey(prefix: UploadPrefix, fileId: string, mime: string): string {
  const ext = extensionForMime(mime);
  if (!ext) {
    throw new Error(`Unsupported mime type "${mime}".`);
  }
  return `${prefix}/${fileId}.${ext}`;
}
