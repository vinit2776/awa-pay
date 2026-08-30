import { and, eq, gt, sql } from "drizzle-orm";
import { withPreAuthLookup } from "@/db/runtime";
import { loginAttempt } from "@/db/schema";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS_PER_EMAIL = 5;
const MAX_ATTEMPTS_PER_IP = 20;

/**
 * Checked before the password is even looked at. Both thresholds count
 * only failed attempts — a login_attempt row's own succeeded flag, not a
 * separate counter, so this reuses the same trail recordLoginAttempt
 * writes rather than duplicating state.
 */
export async function isRateLimited(email: string, ip: string): Promise<boolean> {
  const since = new Date(Date.now() - WINDOW_MS);
  const normalizedEmail = email.trim().toLowerCase();

  const [emailCount, ipCount] = await withPreAuthLookup(
    { email: normalizedEmail, clientIp: ip },
    async (tx) => {
      const [byEmail] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(loginAttempt)
        .where(
          and(
            sql`lower(${loginAttempt.email}) = ${normalizedEmail}`,
            eq(loginAttempt.succeeded, false),
            gt(loginAttempt.createdAt, since),
          ),
        );
      const [byIp] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(loginAttempt)
        .where(and(eq(loginAttempt.ip, ip), eq(loginAttempt.succeeded, false), gt(loginAttempt.createdAt, since)));
      return [byEmail?.count ?? 0, byIp?.count ?? 0];
    },
  );

  return emailCount >= MAX_ATTEMPTS_PER_EMAIL || ipCount >= MAX_ATTEMPTS_PER_IP;
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
