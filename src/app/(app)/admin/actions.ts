"use server";

import { verifySession } from "@/auth/dal";
import {
  forceSignOut as forceSignOutCore,
  grantRole as grantRoleCore,
  type GrantRoleInput,
  type GrantRoleResult,
  revokeGrant as revokeGrantCore,
  type RevokeGrantResult,
} from "@/admin/roleGrantCore";

export async function grantRoleAction(input: GrantRoleInput): Promise<GrantRoleResult> {
  const session = await verifySession();
  return grantRoleCore(session.userId, input);
}

export async function revokeGrantAction(grantId: string): Promise<RevokeGrantResult> {
  const session = await verifySession();
  return revokeGrantCore(session.userId, grantId);
}

export async function forceSignOutAction(userId: string): Promise<void> {
  const session = await verifySession();
  await forceSignOutCore(session.userId, userId);
}
