import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { withActorScope, withGrantScope, withPresentedSessionToken } from "@/db/runtime";
import { session } from "@/db/schema";

// Pure DB operations for the session table — zero next/headers imports,
// so this is directly testable from Vitest (which runs outside any Next
// request scope) without faking cookies()/headers(). src/auth/session.ts
// is the cookie-aware wrapper around these for use from Server
// Actions/pages; tests should import from here, not there.

export const ACTIVE_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h, sliding
export const ACTIVE_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30d hard cap
export const PENDING_MFA_TTL_MS = 10 * 60 * 1000; // 10min
export const MAX_MFA_ATTEMPTS = 5;

export function newRawToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

type SessionMeta = { ip: string; userAgent: string | undefined };

export type StoredSession = {
  id: string;
  userId: string;
  status: "pending_mfa" | "active";
  mfaAttempts: number;
  expiresAt: Date;
  createdAt: Date;
};

export async function insertSession(
  userId: string,
  status: "pending_mfa" | "active",
  meta: SessionMeta,
): Promise<{ rawToken: string; expiresAt: Date }> {
  const rawToken = newRawToken();
  const now = Date.now();
  const expiresAt = new Date(now + (status === "pending_mfa" ? PENDING_MFA_TTL_MS : ACTIVE_SESSION_TTL_MS));

  await withActorScope(userId, (tx) =>
    tx.insert(session).values({
      userId,
      tokenHash: hashToken(rawToken),
      status,
      expiresAt,
      lastSeenAt: status === "active" ? new Date(now) : undefined,
      ip: meta.ip,
      userAgent: meta.userAgent,
    }),
  );

  return { rawToken, expiresAt };
}

/** Looks a session up by its raw (unhashed) token. Optionally filters by status. */
export async function findSessionByRawToken(
  rawToken: string,
  status?: "pending_mfa" | "active",
): Promise<StoredSession | null> {
  const tokenHash = hashToken(rawToken);
  const conditions = [eq(session.tokenHash, tokenHash), isNull(session.revokedAt)];
  if (status) conditions.push(eq(session.status, status));

  const [row] = await withPresentedSessionToken(tokenHash, (tx) =>
    tx
      .select({
        id: session.id,
        userId: session.userId,
        status: session.status,
        mfaAttempts: session.mfaAttempts,
        expiresAt: session.expiresAt,
        createdAt: session.createdAt,
      })
      .from(session)
      .where(and(...conditions))
      .limit(1),
  );

  return (row as StoredSession | undefined) ?? null;
}

export async function revokeSessionById(sessionId: string, userId: string): Promise<void> {
  await withActorScope(userId, (tx) => tx.update(session).set({ revokedAt: new Date() }).where(eq(session.id, sessionId)));
}

export async function slideSessionExpiry(sessionId: string, userId: string, newExpiresAt: Date): Promise<void> {
  await withActorScope(userId, (tx) =>
    tx
      .update(session)
      .set({ expiresAt: newExpiresAt, lastSeenAt: new Date() })
      .where(eq(session.id, sessionId)),
  );
}

/**
 * Raw sql increment (not read-then-write) to stay correct under
 * concurrent attempts. Revokes the session once it hits the cap.
 */
export async function incrementMfaAttempts(
  pendingSessionId: string,
  userId: string,
): Promise<{ attempts: number; revoked: boolean }> {
  return withActorScope(userId, async (tx) => {
    const [row] = await tx
      .update(session)
      .set({ mfaAttempts: sql`${session.mfaAttempts} + 1` })
      .where(eq(session.id, pendingSessionId))
      .returning({ mfaAttempts: session.mfaAttempts });

    const attempts = row?.mfaAttempts ?? MAX_MFA_ATTEMPTS;
    if (attempts >= MAX_MFA_ATTEMPTS) {
      await tx.update(session).set({ revokedAt: new Date() }).where(eq(session.id, pendingSessionId));
      return { attempts, revoked: true };
    }
    return { attempts, revoked: false };
  });
}

/** Session-fixation defense: revoke the pending row, issue a brand new active one. */
export async function promotePendingSession(
  pendingSessionId: string,
  userId: string,
  meta: SessionMeta,
): Promise<{ rawToken: string; expiresAt: Date }> {
  const rawToken = newRawToken();
  const now = Date.now();
  const expiresAt = new Date(now + ACTIVE_SESSION_TTL_MS);

  await withActorScope(userId, async (tx) => {
    await tx.update(session).set({ revokedAt: new Date() }).where(eq(session.id, pendingSessionId));
    await tx.insert(session).values({
      userId,
      tokenHash: hashToken(rawToken),
      status: "active",
      expiresAt,
      lastSeenAt: new Date(now),
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  });

  return { rawToken, expiresAt };
}

/** Admin path — real RLS authority via withGrantScope, never the owner connection. */
export async function revokeAllSessionsForUser(adminId: string, targetUserId: string): Promise<void> {
  await withGrantScope(adminId, "super_admin", (tx) =>
    tx
      .update(session)
      .set({ revokedAt: new Date() })
      .where(and(eq(session.userId, targetUserId), isNull(session.revokedAt))),
  );
}
