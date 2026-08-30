"use server";

import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withActorScope } from "@/db/runtime";
import { mfaBackupCode, user } from "@/db/schema";
import { decryptSecret } from "@/auth/crypto";
import { hashSecret } from "@/auth/password";
import { generateBackupCodes, verifyTotpCode } from "@/auth/totp";
import { getPendingSession, promotePendingToActive } from "@/auth/session";

export type MfaSetupState = { error: string } | { backupCodes: string[] } | undefined;

export async function confirmMfaSetup(_state: MfaSetupState, formData: FormData): Promise<MfaSetupState> {
  const code = String(formData.get("code") ?? "").trim();

  const pending = await getPendingSession();
  if (!pending) {
    redirect("/login");
  }

  if (!code) {
    return { error: "Enter the code from your authenticator app." };
  }

  const h = await headers();
  const forwardedFor = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwardedFor || h.get("x-real-ip") || "unknown";
  const userAgent = h.get("user-agent") ?? undefined;

  const backupCodes = generateBackupCodes();

  const confirmed = await withActorScope(pending.userId, async (tx) => {
    const [foundUser] = await tx.select().from(user).where(eq(user.id, pending.userId)).limit(1);
    if (!foundUser?.mfaSecretEncrypted) return false;

    const secret = decryptSecret(foundUser.mfaSecretEncrypted);
    if (!verifyTotpCode(secret, code)) return false;

    // Backup code hashes are persisted only at this confirmation moment —
    // never left dangling from an abandoned enrollment attempt.
    const hashedCodes = await Promise.all(backupCodes.map((c) => hashSecret(c)));
    await tx.insert(mfaBackupCode).values(hashedCodes.map((codeHash) => ({ userId: pending.userId, codeHash })));
    await tx.update(user).set({ mfaEnrolled: true }).where(eq(user.id, pending.userId));
    return true;
  });

  if (!confirmed) {
    return { error: "That code didn't match. Try again." };
  }

  await promotePendingToActive(pending.id, pending.userId, { ip, userAgent });
  return { backupCodes };
}
