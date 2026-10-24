import { sql } from "drizzle-orm";
import { type ScopedTx, withPreAuthLookup } from "@/db/runtime";
import { loginAttempt } from "@/db/schema";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS_PER_EMAIL = 5;
const MAX_ATTEMPTS_PER_IP = 20;

/**
 * Both failure counts in ONE statement (two scalar subselects), for a
 * caller already inside withPreAuthLookup — login runs this and the user
 * lookup in one transaction. Both thresholds count only failed attempts —
 * a login_attempt row's own succeeded flag, not a separate counter, so this
 * reuses the same trail recordLoginAttempt writes rather than duplicating
 * state.
 */
export async function isRateLimitedInTx(tx: ScopedTx, email: string, ip: string): Promise<boolean> {
  const since = new Date(Date.now() - WINDOW_MS);
  const normalizedEmail = email.trim().toLowerCase();

  const [counts] = await tx.execute<{ by_email: number; by_ip: number }>(sql`
    select
      (select count(*)::int from ${loginAttempt}
        where lower(${loginAttempt.email}) = ${normalizedEmail} and ${loginAttempt.succeeded} = false and ${loginAttempt.createdAt} > ${since.toISOString()}::timestamptz) as by_email,
      (select count(*)::int from ${loginAttempt}
        where ${loginAttempt.ip} = ${ip} and ${loginAttempt.succeeded} = false and ${loginAttempt.createdAt} > ${since.toISOString()}::timestamptz) as by_ip
  `);

  return (counts?.by_email ?? 0) >= MAX_ATTEMPTS_PER_EMAIL || (counts?.by_ip ?? 0) >= MAX_ATTEMPTS_PER_IP;
}

/**
 * Checked before the password is even looked at.
 */
export async function isRateLimited(email: string, ip: string): Promise<boolean> {
  return withPreAuthLookup({ email: email.trim().toLowerCase(), clientIp: ip }, (tx) => isRateLimitedInTx(tx, email, ip));
}

export async function recordLoginAttempt(params: {
  email: string;
  ip: string;
  userAgent: string | undefined;
  succeeded: boolean;
  failureReason?: string;
}): Promise<void> {
  await withPreAuthLookup({ email: params.email.trim().toLowerCase(), clientIp: params.ip }, (tx) =>
    tx.insert(loginAttempt).values({
      email: params.email.trim().toLowerCase(),
      ip: params.ip,
      userAgent: params.userAgent,
      succeeded: params.succeeded,
      failureReason: params.failureReason,
    }),
  );
}
