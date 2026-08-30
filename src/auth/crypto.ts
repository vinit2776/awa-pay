import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { MFA_ENCRYPTION_KEY } from "./env";

const key = Buffer.from(MFA_ENCRYPTION_KEY, "base64");
if (key.length !== 32) {
  throw new Error("MFA_ENCRYPTION_KEY must decode to 32 bytes (openssl rand -base64 32).");
}

// AES-256-GCM. Layout: 12-byte IV || ciphertext || 16-byte auth tag, all
// base64-encoded into one text column (user.mfa_secret_encrypted).
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, tag]).toString("base64");
}

export function decryptSecret(encoded: string): string {
  const raw = Buffer.from(encoded, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(12, raw.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
