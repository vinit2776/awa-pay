// The one process.env read point for auth, mirroring src/db/runtime.ts's
// DATABASE_URL pattern. Nothing else under src/ may read these directly —
// enforced by eslint.config.mjs's no-restricted-properties rule.
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  throw new Error("SESSION_SECRET is not set. See .env.example.");
}

const mfaEncryptionKey = process.env.MFA_ENCRYPTION_KEY;
if (!mfaEncryptionKey) {
  throw new Error("MFA_ENCRYPTION_KEY is not set. See .env.example.");
}

export const SESSION_SECRET = sessionSecret;
export const MFA_ENCRYPTION_KEY = mfaEncryptionKey;
export const IS_PRODUCTION = process.env.NODE_ENV === "production";
