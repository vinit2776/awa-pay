import { randomUUID } from "node:crypto";
import { ALLOWED_MIME_TYPES, buildStorageKey, type UploadPrefix } from "./storageKey";
import { presignPutUrl } from "./r2";

// Shared by every "use server" action that needs to mint a presigned
// upload slot before a client PUTs bytes to R2 — first used by capture
// (src/app/(app)/requests/new/actions.ts), reused by the payer's optional
// advice attachment and by vendor document upload (both under
// src/app/(app)/requests/[id]/actions.ts and src/app/(app)/vendors/[id]/
// actions.ts respectively). Callers are responsible for their own
// verifySession() first — this function doesn't know about auth, it only
// knows about R2.
export type UploadSlotResult =
  | { ok: true; fileId: string; storageKey: string; uploadUrl: string }
  | { ok: false; error: string };

export async function mintUploadSlot(prefix: UploadPrefix, mime: string): Promise<UploadSlotResult> {
  if (!ALLOWED_MIME_TYPES.includes(mime)) {
    return { ok: false, error: `Unsupported file type "${mime}".` };
  }

  const fileId = randomUUID();
  const storageKey = buildStorageKey(prefix, fileId, mime);
  const uploadUrl = await presignPutUrl(storageKey, mime);

  return { ok: true, fileId, storageKey, uploadUrl };
}
