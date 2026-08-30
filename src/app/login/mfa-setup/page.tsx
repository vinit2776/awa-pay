import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { Secret } from "otpauth";
import { withActorScope } from "@/db/runtime";
import { user } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/auth/crypto";
import { buildOtpauthUri, generateTotpSecret } from "@/auth/totp";
import { getPendingSession } from "@/auth/session";
import { MfaSetupForm } from "./MfaSetupForm";

export default async function MfaSetupPage() {
  const pending = await getPendingSession();
  if (!pending) {
    redirect("/login");
  }

  const otpauthUri = await withActorScope(pending.userId, async (tx) => {
    const [foundUser] = await tx.select().from(user).where(eq(user.id, pending.userId)).limit(1);
    if (!foundUser) redirect("/login");
    if (foundUser.mfaEnrolled) redirect("/login/mfa");

    // Reuse an in-progress secret rather than regenerating on every render
    // (a refresh shouldn't invalidate a QR code someone already scanned).
    if (foundUser.mfaSecretEncrypted) {
      return buildOtpauthUri(Secret.fromBase32(decryptSecret(foundUser.mfaSecretEncrypted)), foundUser.email);
    }

    const secret = generateTotpSecret();
    await tx.update(user).set({ mfaSecretEncrypted: encryptSecret(secret.base32) }).where(eq(user.id, foundUser.id));
    return buildOtpauthUri(secret, foundUser.email);
  });

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 text-center">
      <h1 className="text-2xl font-semibold">Set up your authenticator app</h1>
      <p className="max-w-sm text-sm text-zinc-600 dark:text-zinc-400">
        The payer role requires two-factor authentication. Scan this with an authenticator app (Google
        Authenticator, 1Password, etc.), or enter the URI manually.
      </p>
      <code className="w-full max-w-sm break-all rounded bg-zinc-100 p-3 text-xs dark:bg-zinc-900">
        {otpauthUri}
      </code>
      <MfaSetupForm />
    </div>
  );
}
