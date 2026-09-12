import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { R2_ACCESS_KEY_ID, R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_SECRET_ACCESS_KEY } from "./env";

const UPLOAD_URL_EXPIRY_SECONDS = 10 * 60; // long enough for a multi-MB PUT over 3G
const DOWNLOAD_URL_EXPIRY_SECONDS = 5 * 60; // short-lived, view/download only

// forcePathStyle is required for R2: its URL shape is
// https://<account>.r2.cloudflarestorage.com/<bucket>/<key> (path-style).
// Without this the SDK defaults to virtual-hosted-style
// (<bucket>.<account>.r2.cloudflarestorage.com), which R2 doesn't serve.
const client = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  forcePathStyle: true,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

export async function presignPutUrl(storageKey: string, mime: string): Promise<string> {
  const command = new PutObjectCommand({ Bucket: R2_BUCKET_NAME, Key: storageKey, ContentType: mime });
  return getSignedUrl(client, command, { expiresIn: UPLOAD_URL_EXPIRY_SECONDS });
}

// Zero authorization inside this function, by design, matching
// presignPutUrl above: the security boundary is entirely upstream — a
// caller only ever has a storageKey to sign because it came out of an
// RLS-scoped query inside withGrantScope (see
// src/app/(app)/requests/[id]/page.tsx, the only caller in phase 4).
export async function presignGetUrl(storageKey: string): Promise<string> {
  const command = new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: storageKey });
  return getSignedUrl(client, command, { expiresIn: DOWNLOAD_URL_EXPIRY_SECONDS });
}

// The server-side corroboration for "checksum on arrival" (see
// src/requests/captureCore.ts): R2's own authoritative ContentLength,
// compared against what the client reported. Not a checksum recomputation
// — that would need re-downloading the object, which reintroduces the
// "proxy bytes through a serverless function" cost the presigned-upload
// flow exists to avoid.
export async function headObjectContentLength(storageKey: string): Promise<number | null> {
  try {
    const result = await client.send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: storageKey }));
    return result.ContentLength ?? null;
  } catch {
    return null;
  }
}

// The one place this codebase actually downloads a bill's bytes, rather
// than just presigning access to them — extraction (phase 13) needs the
// real pixels for the vision call and, for images, the dHash. Every other
// caller (comment attachments, vendor documents, the request detail page)
// only ever needs presignGetUrl; don't reach for this for anything that
// can be served as a redirect instead.
export async function getObjectBytes(storageKey: string): Promise<Buffer> {
  const result = await client.send(new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: storageKey }));
  const bytes = await result.Body?.transformToByteArray();
  if (!bytes) {
    throw new Error(`Object body was empty: ${storageKey}`);
  }
  return Buffer.from(bytes);
}
