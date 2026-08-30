// Split from session.ts deliberately: this file has zero DB imports so
// src/proxy.ts can import the cookie name without pulling postgres/drizzle
// into the proxy bundle.
export const SESSION_COOKIE = "awa_session";
export const MFA_PENDING_COOKIE = "awa_mfa_pending";
