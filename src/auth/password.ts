import { hash, verify } from "@node-rs/argon2";

// argon2id, library defaults (memoryCost=19456 KiB, timeCost=2,
// parallelism=1) — already at OWASP's current minimum recommendation.
// Reused for MFA backup codes too ("hashed the same way as passwords").
export async function hashSecret(secret: string): Promise<string> {
  return hash(secret);
}

export async function verifySecret(hashed: string, secret: string): Promise<boolean> {
  return verify(hashed, secret);
}
