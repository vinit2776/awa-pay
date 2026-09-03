// The one process.env read point for notifications, mirroring
// src/auth/env.ts's/src/storage/env.ts's pattern — see
// eslint.config.mjs's no-restricted-properties rule.
//
// Unlike SESSION_SECRET/R2_*, these are deliberately NOT required at
// import time. Rule 5 says an unconfigured integration fails visibly at
// the edge, not by crashing the app — RESEND_API_KEY is unset in CI
// today (.env.example says so explicitly), so every test run already
// exercises the "no key configured" path for free, with no separate
// test-mode flag needed.
export const RESEND_API_KEY = process.env.RESEND_API_KEY || null;
export const EMAIL_FROM = process.env.EMAIL_FROM || null;
