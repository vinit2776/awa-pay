"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { verifyMfaCode } from "@/auth/mfaCore";
import { clearAuthCookies, clearMfaPendingCookie, getPendingSession, setSessionCookie } from "@/auth/session";

export type MfaState = { error: string } | undefined;

export async function verifyMfa(_state: MfaState, formData: FormData): Promise<MfaState> {
  const code = String(formData.get("code") ?? "").trim();

  const pending = await getPendingSession();
  if (!pending) {
    redirect("/login");
  }

  if (!code) {
    return { error: "Enter a code." };
  }

  const h = await headers();
  const forwardedFor = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwardedFor || h.get("x-real-ip") || "unknown";
  const userAgent = h.get("user-agent") ?? undefined;

  const result = await verifyMfaCode(pending.id, pending.userId, code, { ip, userAgent });

  if (!result.ok) {
    if (result.sessionRevoked) {
      await clearAuthCookies();
      redirect("/login");
    }
    return { error: result.error };
  }

  await setSessionCookie(result.rawToken, result.expiresAt);
  await clearMfaPendingCookie();
  redirect("/");
}
