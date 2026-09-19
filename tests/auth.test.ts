import { and, eq } from "drizzle-orm";
import { Secret, TOTP } from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeOwnerConnection, dbOwner } from "../scripts/db-owner";
import { cleanupFixturesForNonce } from "../scripts/fixtures";
import { encryptSecret } from "../src/auth/crypto";
import { attemptLogin } from "../src/auth/loginCore";
import { verifyMfaCode } from "../src/auth/mfaCore";
import { hashSecret } from "../src/auth/password";
import { findSessionByRawToken, hashToken } from "../src/auth/sessionStore";
import { loginAttempt, roleGrant, session, user } from "../src/db/schema";

// The phase-2 gate, per docs/START-HERE.md phase 2. Exercises the real
// pure core (attemptLogin, verifyMfaCode, sessionStore) — the same code
// the Server Actions under src/app/login/** call — not a parallel test
// client. next/headers-dependent code (cookies) lives only in
// src/auth/session.ts, deliberately not exercised here; see that file's
// header comment.

const nonce = crypto.randomUUID().slice(0, 8);
const PASSWORD = "correct horse battery staple 42";
const META = { ip: "203.0.113.10", userAgent: "vitest" };

let plainUser: { id: string; email: string };
let payerUser: { id: string; email: string };
let totpSecret: Secret;

beforeAll(async () => {
  const passwordHash = await hashSecret(PASSWORD);

  [plainUser] = await dbOwner
    .insert(user)
    .values({
      name: `Auth Test Plain ${nonce}`,
      email: `auth-test-plain-${nonce}@example.invalid`,
      passwordHash,
    })
    .returning({ id: user.id, email: user.email });

  totpSecret = new Secret();

  [payerUser] = await dbOwner
    .insert(user)
    .values({
      name: `Auth Test Payer ${nonce}`,
      email: `auth-test-payer-${nonce}@example.invalid`,
      passwordHash,
      mfaEnrolled: true,
      mfaSecretEncrypted: encryptSecret(totpSecret.base32),
    })
    .returning({ id: user.id, email: user.email });

  await dbOwner.insert(roleGrant).values({
    userId: payerUser.id,
    role: "payer",
    deptScope: "global",
    companyScope: "global",
    grantedBy: payerUser.id,
  });
});

afterAll(async () => {
  try {
    await dbOwner.delete(loginAttempt).where(eq(loginAttempt.email, "nobody@example.invalid"));
    await cleanupFixturesForNonce(dbOwner, nonce);
  } finally {
    await closeOwnerConnection();
  }
});

describe("login (the phase-2 gate)", () => {
  it("a correct password for a non-payer account produces an active session", async () => {
    const result = await attemptLogin({ email: plainUser.email, password: PASSWORD, ...META });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.requiresMfa).toBe(false);

    const found = await findSessionByRawToken(result.rawToken, "active");
    expect(found).not.toBeNull();
    expect(found?.userId).toBe(plainUser.id);
  });

  it("an unknown email fails generically and leaves a login_attempt row an operator can see", async () => {
    const result = await attemptLogin({
      email: "nobody@example.invalid",
      password: "whatever",
      ...META,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("Invalid email or password.");

    const rows = await dbOwner
      .select()
      .from(loginAttempt)
      .where(and(eq(loginAttempt.email, "nobody@example.invalid"), eq(loginAttempt.succeeded, false)));
    expect(rows.some((r) => r.failureReason === "no_such_user")).toBe(true);
  });

  it("a payer-role account is held at pending_mfa until the correct TOTP code is presented", async () => {
    const loginResult = await attemptLogin({ email: payerUser.email, password: PASSWORD, ...META });
    expect(loginResult.ok).toBe(true);
    if (!loginResult.ok) return;
    expect(loginResult.requiresMfa).toBe(true);

    const pending = await findSessionByRawToken(loginResult.rawToken, "pending_mfa");
    expect(pending).not.toBeNull();
    if (!pending) return;

    const wrongAttempt = await verifyMfaCode(pending.id, payerUser.id, "000000", META);
    expect(wrongAttempt.ok).toBe(false);

    const stillPending = await findSessionByRawToken(loginResult.rawToken, "pending_mfa");
    expect(stillPending).not.toBeNull();

    const validCode = new TOTP({ secret: totpSecret }).generate();
    const rightAttempt = await verifyMfaCode(pending.id, payerUser.id, validCode, META);
    expect(rightAttempt.ok).toBe(true);
    if (!rightAttempt.ok) return;

    const revokedPending = await findSessionByRawToken(loginResult.rawToken, "pending_mfa");
    expect(revokedPending).toBeNull(); // revoked by the promotion

    const active = await findSessionByRawToken(rightAttempt.rawToken, "active");
    expect(active).not.toBeNull();
    expect(active?.userId).toBe(payerUser.id);
  });

  it("a revoked session is rejected on the next lookup", async () => {
    const rawToken = "revoked-session-test-token";
    const tokenHash = hashToken(rawToken);

    const [inserted] = await dbOwner
      .insert(session)
      .values({
        userId: plainUser.id,
        tokenHash,
        status: "active",
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: new Date(),
      })
      .returning({ id: session.id });

    const found = await findSessionByRawToken(rawToken, "active");
    expect(found).toBeNull();

    await dbOwner.delete(session).where(eq(session.id, inserted.id));
  });

  it(
    "stops checking the password once an account has too many recent failed attempts",
    async () => {
      for (let i = 0; i < 5; i++) {
        const result = await attemptLogin({ email: plainUser.email, password: "wrong", ...META });
        expect(result.ok).toBe(false);
      }

      const result = await attemptLogin({ email: plainUser.email, password: PASSWORD, ...META });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/too many attempts/i);
    },
  );
});
