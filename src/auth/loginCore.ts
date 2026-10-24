import { eq, sql } from "drizzle-orm";
import { withActorScope, withPreAuthLookup } from "@/db/runtime";
import { user } from "@/db/schema";
import { verifySecret } from "./password";
import { isRateLimitedInTx, recordLoginAttempt } from "./rateLimit";
import { getActiveRoleGrants } from "./roles";
import { insertSessionInTx } from "./sessionStore";

// Pure orchestration, no next/headers or next/navigation — testable
// directly from Vitest. src/app/login/actions.ts is the thin "use server"
// wrapper that gathers ip/userAgent via headers() and turns the result
// below into a cookie + redirect.

export type LoginResult =
  | { ok: true; requiresMfa: boolean; mfaEnrolled: boolean; rawToken: string; expiresAt: Date }
  | { ok: false; error: string };

const GENERIC_ERROR = "Invalid email or password.";

export async function attemptLogin(params: {
  email: string;
  password: string;
  ip: string;
  userAgent: string | undefined;
}): Promise<LoginResult> {
  const { password, ip, userAgent } = params;
  const email = params.email.trim();

  if (!email || !password) {
    return { ok: false, error: "Enter your email and password." };
  }

  const normalizedEmail = email.toLowerCase();

  // Rate-limit counts and the user lookup share one transaction: both read
  // under the same presented email/ip, and every extra transaction is a
  // full scope setup plus commit on a path where round trips are the cost.
  // Looking the user up even when about to answer "rate limited" reveals
  // nothing — the result is discarded and the caller sees only the
  // rate-limit message.
  const { limited, foundUser } = await withPreAuthLookup({ email: normalizedEmail, clientIp: ip }, async (tx) => {
    const limited = await isRateLimitedInTx(tx, email, ip);
    const [foundUser] = await tx
      .select()
      .from(user)
      .where(sql`lower(${user.email}) = ${normalizedEmail}`)
      .limit(1);
    return { limited, foundUser };
  });

  if (limited) {
    return { ok: false, error: "Too many attempts. Try again in a few minutes." };
  }

  // Provisioning stays admin-only: an unknown email means an admin step is
  // missing, not that this person should be invited to sign up. The user
  // sees the same generic error as every other failure (anti-enumeration);
  // the specific reason lands only in login_attempt for an operator to see.
  if (!foundUser) {
    await recordLoginAttempt({ email, ip, userAgent, succeeded: false, failureReason: "no_such_user" });
    return { ok: false, error: GENERIC_ERROR };
  }

  if (foundUser.status === "disabled") {
    await recordLoginAttempt({ email, ip, userAgent, succeeded: false, failureReason: "disabled" });
    return { ok: false, error: GENERIC_ERROR };
  }

  if (foundUser.lockedUntil && foundUser.lockedUntil.getTime() > Date.now()) {
    await recordLoginAttempt({ email, ip, userAgent, succeeded: false, failureReason: "locked" });
    return { ok: false, error: GENERIC_ERROR };
  }

  const passwordOk = await verifySecret(foundUser.passwordHash, password);
  if (!passwordOk) {
    // Two independent writes under different scopes (own-row user update;
    // pre-auth login_attempt insert) — parallel connections, not in series.
    await Promise.all([
      withActorScope(foundUser.id, (tx) =>
        tx
          .update(user)
          .set({ failedLoginCount: sql`${user.failedLoginCount} + 1` })
          .where(eq(user.id, foundUser.id)),
      ),
      recordLoginAttempt({ email, ip, userAgent, succeeded: false, failureReason: "bad_password" }),
    ]);
    return { ok: false, error: GENERIC_ERROR };
  }

  // The own-row reset, the grant read that decides MFA, and the session
  // insert are all identity-scoped: one transaction. The login_attempt row
  // needs the pre-auth scope instead, so it runs alongside on its own
  // connection rather than after.
  const [{ requiresMfa, rawToken, expiresAt }] = await Promise.all([
    withActorScope(foundUser.id, async (tx) => {
      await tx.update(user).set({ failedLoginCount: 0, lastSeen: new Date() }).where(eq(user.id, foundUser.id));
      const grants = await getActiveRoleGrants(tx, foundUser.id);
      const requiresMfa = grants.some((grant) => grant.role === "payer");
      const session = await insertSessionInTx(tx, foundUser.id, requiresMfa ? "pending_mfa" : "active", { ip, userAgent });
      return { requiresMfa, ...session };
    }),
    recordLoginAttempt({ email, ip, userAgent, succeeded: true }),
  ]);

  return { ok: true, requiresMfa, mfaEnrolled: foundUser.mfaEnrolled, rawToken, expiresAt };
}
