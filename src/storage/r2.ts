import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { R2_ACCESS_KEY_ID, R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_SECRET_ACCESS_KEY } from "./env";

const UPLOAD_URL_EXPIRY_SECONDS = 10 * 60; // long enough for a multi-MB PUT over 3G

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
