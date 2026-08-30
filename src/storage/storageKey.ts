// bills/{fileId}.{ext} — no departmentId prefix. fileId is a server-
// generated UUIDv4, not client input, so the key is already collision-
// proof and non-enumerable on its own; the real traceability path is
// storageKey -> fileId -> request_file.id -> request_file.request_id ->
// request.ref, a one-hop DB lookup once request_file is inserted at
// submit. A department prefix would need the department chosen before the
// first file attach and would go stale if it changed afterward — not
// worth that ordering constraint for a convenience an auditor can get via
// one join anyway.
const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "application/pdf": "pdf",
};

export const ALLOWED_MIME_TYPES = Object.keys(MIME_EXTENSIONS);

export function extensionForMime(mime: string): string | null {
  return MIME_EXTENSIONS[mime] ?? null;
}

export function buildStorageKey(fileId: string, mime: string): string {
  const ext = extensionForMime(mime);
  if (!ext) {
    throw new Error(`Unsupported mime type "${mime}".`);
  }
  return `bills/${fileId}.${ext}`;
}
