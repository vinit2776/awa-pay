import { and, eq, inArray, isNull } from "drizzle-orm";
import { type Role, withActorScope } from "@/db/runtime";
import { roleGrant } from "@/db/schema";

// vendor/vendor_bank/vendor_document are role-scoped only (0015) — unlike
// request's department-scoped resolveViewerRole (src/requests/viewerRole.ts),
// visibility here doesn't vary by which of these roles is used, so there's
// no need to try each one against RLS and see what comes back. A direct
// role_grant read (via withActorScope, identity-only — role_grant_select's
// own-row branch doesn't require app.actor_role) is enough to know which
// of the roles this page cares about the actor actually holds.
const VENDOR_VIEWER_ROLES: Role[] = ["accountant", "payer", "super_admin", "developer"];

export async function resolveVendorViewerRoles(userId: string): Promise<Role[]> {
  const rows = await withActorScope(userId, (tx) =>
    tx
      .select({ role: roleGrant.role })
      .from(roleGrant)
      .where(and(eq(roleGrant.userId, userId), inArray(roleGrant.role, VENDOR_VIEWER_ROLES), isNull(roleGrant.revokedAt))),
  );
  const held = new Set(rows.map((r) => r.role));
  return VENDOR_VIEWER_ROLES.filter((r) => held.has(r));
}

// Which of the two roles vendor_insert/vendor_update/vendor_document_insert
// (0015) actually grant this actor write access under — never trusted from
// the client, always re-resolved server-side inside the action itself.
export async function resolveVendorWriterRole(userId: string): Promise<"accountant" | "super_admin" | null> {
  const roles = await resolveVendorViewerRoles(userId);
  if (roles.includes("accountant")) return "accountant";
  if (roles.includes("super_admin")) return "super_admin";
  return null;
}
