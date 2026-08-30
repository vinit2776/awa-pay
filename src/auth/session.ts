import { cookies } from "next/headers";
import { signToken, verifyAndExtractToken } from "./cookieSignature";
import { MFA_PENDING_COOKIE, SESSION_COOKIE } from "./cookieNames";
import { IS_PRODUCTION } from "./env";
import {
  ACTIVE_SESSION_MAX_AGE_MS,
  ACTIVE_SESSION_TTL_MS,
  findSessionByRawToken,
  incrementMfaAttempts,
  promotePendingSession,
  revokeSessionById,
  slideSessionExpiry,
} from "./sessionStore";

export { SESSION_COOKIE, MFA_PENDING_COOKIE };
export { revokeAllSessionsForUser } from "./sessionStore";

// The cookie-aware layer. Everything here calls next/headers's cookies(),
// so it only works inside a real Next request (Server Component/Action/
// Route Handler) — never call these from tests. tests/auth.test.ts
// exercises src/auth/sessionStore.ts directly instead, which has no such
// requirement.

function cookieOptions(path: string, expiresAt: Date) {
  return { httpOnly: true, secure: IS_PRODUCTION, sameSite: "lax" as const, path, expires: expiresAt };
}

async function setCookie(name: string, rawToken: string, path: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set(name, signToken(rawToken), cookieOptions(path, expiresAt));
}

export async function clearAuthCookies(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  store.delete(MFA_PENDING_COOKIE);
}

type SessionMeta = { ip: string; userAgent: string | undefined };

/** Called by the login Server Action after attemptLogin() has already created the session row. */
export async function setSessionCookie(rawToken: string, expiresAt: Date): Promise<void> {
  await setCookie(SESSION_COOKIE, rawToken, "/", expiresAt);
}

export async function setMfaPendingCookie(rawToken: string, expiresAt: Date): Promise<void> {
  await setCookie(MFA_PENDING_COOKIE, rawToken, "/login", expiresAt);
}

export async function clearMfaPendingCookie(): Promise<void> {
  const store = await cookies();
  store.delete(MFA_PENDING_COOKIE);
}

/**
 * Reads the pending-MFA session from the awa_mfa_pending cookie. Returns
 * null if the cookie is missing/tampered, the row doesn't exist, it's
 * revoked, expired, or already promoted to active.
 */
export async function getPendingSession(): Promise<{ id: string; userId: string; mfaAttempts: number } | null> {
  const store = await cookies();
  const cookieValue = store.get(MFA_PENDING_COOKIE)?.value;
  if (!cookieValue) return null;

  const rawToken = verifyAndExtractToken(cookieValue);
  if (!rawToken) return null;

  const found = await findSessionByRawToken(rawToken, "pending_mfa");
  if (!found || found.expiresAt.getTime() <= Date.now()) return null;

  return { id: found.id, userId: found.userId, mfaAttempts: found.mfaAttempts };
}

/** Returns false once the pending session has been revoked past the attempt cap. */
export async function recordFailedMfaAttempt(pendingSessionId: string, userId: string): Promise<boolean> {
  const { revoked } = await incrementMfaAttempts(pendingSessionId, userId);
  return !revoked;
}

export async function promotePendingToActive(pendingSessionId: string, userId: string, meta: SessionMeta): Promise<void> {
  const { rawToken, expiresAt } = await promotePendingSession(pendingSessionId, userId, meta);
  await setCookie(SESSION_COOKIE, rawToken, "/", expiresAt);
  const store = await cookies();
  store.delete(MFA_PENDING_COOKIE);
}

export type CurrentSession = { id: string; userId: string; expiresAt: Date };

/**
 * The DAL's real, DB-backed check — never called from proxy.ts. Verifies
 * the awa_session cookie, looks the token up by hash, rejects revoked/
 * expired/pending sessions, and slides the expiry forward on activity
 * (capped at ACTIVE_SESSION_MAX_AGE_MS from creation).
 */
export async function verifyActiveSession(): Promise<CurrentSession | null> {
  const store = await cookies();
  const cookieValue = store.get(SESSION_COOKIE)?.value;
  if (!cookieValue) return null;

  const rawToken = verifyAndExtractToken(cookieValue);
  if (!rawToken) return null;

  const found = await findSessionByRawToken(rawToken, "active");
  if (!found) return null;

  const now = Date.now();
  if (found.expiresAt.getTime() <= now) return null;
  if (found.createdAt.getTime() + ACTIVE_SESSION_MAX_AGE_MS <= now) return null;

  const oneHourAgo = now - 60 * 60 * 1000;
  if (found.expiresAt.getTime() - ACTIVE_SESSION_TTL_MS < oneHourAgo) {
    const newExpiresAt = new Date(
      Math.min(now + ACTIVE_SESSION_TTL_MS, found.createdAt.getTime() + ACTIVE_SESSION_MAX_AGE_MS),
    );
    await slideSessionExpiry(found.id, found.userId, newExpiresAt);
    await setCookie(SESSION_COOKIE, rawToken, "/", newExpiresAt);
  }

  return { id: found.id, userId: found.userId, expiresAt: found.expiresAt };
}

export async function revokeCurrentSession(): Promise<void> {
  const current = await verifyActiveSession();
  if (current) {
    await revokeSessionById(current.id, current.userId);
  }
  await clearAuthCookies();
}
