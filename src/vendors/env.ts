// The one process.env read point for vendor bank encryption, mirroring
// src/auth/env.ts's pattern exactly. See eslint.config.mjs's
// no-restricted-properties rule.
const bankAccountEncryptionKey = process.env.BANK_ACCOUNT_ENCRYPTION_KEY;
if (!bankAccountEncryptionKey) {
  throw new Error("BANK_ACCOUNT_ENCRYPTION_KEY is not set. See .env.example.");
}

export const BANK_ACCOUNT_ENCRYPTION_KEY = bankAccountEncryptionKey;
