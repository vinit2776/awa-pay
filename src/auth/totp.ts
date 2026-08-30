import { randomBytes } from "node:crypto";
import { Secret, TOTP } from "otpauth";

function totpFor(secret: Secret): TOTP {
  return new TOTP({ issuer: "awa-pay", label: "awa-pay", secret });
}

export function generateTotpSecret(): Secret {
  return new Secret();
}

export function buildOtpauthUri(secret: Secret, accountLabel: string): string {
  const totp = new TOTP({ issuer: "awa-pay", label: accountLabel, secret });
  return totp.toString();
}

// null delta means the code didn't validate within the +/-1 step window.
export function verifyTotpCode(secretBase32: string, token: string): boolean {
  const secret = Secret.fromBase32(secretBase32);
  const delta = totpFor(secret).validate({ token, window: 1 });
  return delta !== null;
}

// 8 single-use codes, hashed like passwords once generated (see
// src/auth/password.ts) and shown to the user exactly once at enrollment.
export function generateBackupCodes(count = 8): string[] {
  return Array.from({ length: count }, () => randomBytes(5).toString("hex"));
}
