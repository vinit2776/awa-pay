"use server";

import { redirect } from "next/navigation";
import { revokeCurrentSession } from "@/auth/session";

export async function logout(): Promise<void> {
  await revokeCurrentSession();
  redirect("/login");
}
