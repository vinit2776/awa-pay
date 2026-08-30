"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { attemptLogin } from "@/auth/loginCore";
import { setMfaPendingCookie, setSessionCookie } from "@/auth/session";

export type LoginState = { error: string } | undefined;

async function getClientMeta(): Promise<{ ip: string; userAgent: string | undefined }> {
  const h = await headers();
  const forwardedFor = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwardedFor || h.get("x-real-ip") || "unknown";
  return { ip, userAgent: h.get("user-agent") ?? undefined };
}

export async function login(_state: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const { ip, userAgent } = await getClientMeta();

  const result = await attemptLogin({ email, password, ip, userAgent });

  if (!result.ok) {
    return { error: result.error };
  }

  if (result.requiresMfa) {
    await setMfaPendingCookie(result.rawToken, result.expiresAt);
    redirect(result.mfaEnrolled ? "/login/mfa" : "/login/mfa-setup");
  }

  await setSessionCookie(result.rawToken, result.expiresAt);
  redirect("/");
}
