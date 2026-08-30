import { and, eq, isNull } from "drizzle-orm";
import { withActorScope } from "@/db/runtime";
import { mfaBackupCode, user } from "@/db/schema";
import { decryptSecret } from "./crypto";
import { verifySecret } from "./password";
import { incrementMfaAttempts, promotePendingSession } from "./sessionStore";
import { verifyTotpCode } from "./totp";

// Pure orchestration, no next/headers or next/navigation — testable
// directly from Vitest. src/app/login/mfa/actions.ts is the thin
// "use server" wrapper.

export type MfaVerifyResult =
  | { ok: true; rawToken: string; expiresAt: Date }
  | { ok: false; error: string; sessionRevoked: boolean };

export async function verifyMfaCode(
  pendingSessionId: string,
  userId: string,
  code: string,
  meta: { ip: string; userAgent: string | undefined },
): Promise<MfaVerifyResult> {
  const valid = await withActorScope(userId, async (tx) => {
    const [foundUser] = await tx.select().from(user).where(eq(user.id, userId)).limit(1);
    if (!foundUser?.mfaSecretEncrypted) return false;

    const secret = decryptSecret(foundUser.mfaSecretEncrypted);
    if (verifyTotpCode(secret, code)) return true;

    const unusedCodes = await tx
      .select()
      .from(mfaBackupCode)
      .where(and(eq(mfaBackupCode.userId, userId), isNull(mfaBackupCode.usedAt)));

    for (const backup of unusedCodes) {
      if (await verifySecret(backup.codeHash, code)) {
        await tx.update(mfaBackupCode).set({ usedAt: new Date() }).where(eq(mfaBackupCode.id, backup.id));
        return true;
      }
    }
    return false;
  });

  if (!valid) {
    const { revoked } = await incrementMfaAttempts(pendingSessionId, userId);
    return { ok: false, error: "Invalid code.", sessionRevoked: revoked };
  }

  const { rawToken, expiresAt } = await promotePendingSession(pendingSessionId, userId, meta);
  return { ok: true, rawToken, expiresAt };
}
