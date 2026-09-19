import { and, asc, eq, ilike, isNull, or } from "drizzle-orm";
import { revokeAllSessionsForUser } from "@/auth/sessionStore";
import { type Role, withGrantScope } from "@/db/runtime";
import { roleGrant, user } from "@/db/schema";
// Shared with the grant form, so what it offers and what this enforces
// can't drift apart.
import { ALWAYS_GLOBAL_ROLES, COMPANY_SCOPED_ROLES } from "./grantRules";

// Pure orchestration, mirrors src/vendors/vendorsCore.ts's shape. Every
// function here takes the super_admin's own actorId and goes through the
// same withGrantScope(actorId, "super_admin", ...) every other role-gated
// query uses — role_grant_select/insert/update (0001_rls_and_grants.sql)
// already grant super_admin full read/write on role_grant, and user_select
// (0003_auth_rls_and_grants.sql) already grants full read on user. No new
// RLS was needed to build this file.

export type AdminUserSummary = { id: string; name: string; email: string; status: string; mfaEnrolled: boolean };

export async function listUsers(actorId: string, term?: string): Promise<AdminUserSummary[]> {
  const trimmed = term?.trim();
  return withGrantScope(actorId, "super_admin", (tx) =>
    tx
      .select({ id: user.id, name: user.name, email: user.email, status: user.status, mfaEnrolled: user.mfaEnrolled })
      .from(user)
      .where(trimmed ? or(ilike(user.name, `%${trimmed}%`), ilike(user.email, `%${trimmed}%`)) : undefined)
      .orderBy(asc(user.name)),
  );
}

export type RoleGrantRow = typeof roleGrant.$inferSelect;

export async function getUserWithGrants(
  actorId: string,
  userId: string,
): Promise<{ user: AdminUserSummary; grants: RoleGrantRow[] } | null> {
  return withGrantScope(actorId, "super_admin", async (tx) => {
    const [row] = await tx
      .select({ id: user.id, name: user.name, email: user.email, status: user.status, mfaEnrolled: user.mfaEnrolled })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    if (!row) return null;

    const grants = await tx.select().from(roleGrant).where(eq(roleGrant.userId, userId)).orderBy(asc(roleGrant.grantedAt));
    return { user: row, grants };
  });
}

export type GrantRoleInput = {
  userId: string;
  role: Role;
  deptScope: "global" | "list";
  departmentIds: string[];
  companyScope: "global" | "list" | "n/a";
  companyIds: string[];
};

export type GrantRoleResult = { ok: true; id: string } | { ok: false; error: string };

// Defense-in-depth mirror of the DB CHECK constraints
// (role_grant_requester_not_global_check, role_grant_dept_scope_list_check,
// role_grant_company_scope_list_check) — a friendly error here beats a raw
// constraint-violation message reaching the form, and normalizing
// scope-irrelevant fields here (rather than trusting the form) means a
// stale/tampered client payload can't grant more than the role allows.
export async function grantRole(actorId: string, input: GrantRoleInput): Promise<GrantRoleResult> {
  let deptScope = input.deptScope;
  let departmentIds: string[] | null = input.departmentIds;
  let companyScope = input.companyScope;
  let companyIds: string[] | null = input.companyIds;

  if (ALWAYS_GLOBAL_ROLES.has(input.role)) {
    deptScope = "global";
    departmentIds = null;
    companyScope = "n/a";
    companyIds = null;
  } else if (!COMPANY_SCOPED_ROLES.has(input.role)) {
    companyScope = "n/a";
    companyIds = null;
  }

  if (input.role === "requester" && deptScope === "global") {
    return { ok: false, error: "A requester can never hold global department scope — pick specific departments." };
  }
  if (deptScope === "list" && (!departmentIds || departmentIds.length === 0)) {
    return { ok: false, error: "Pick at least one department for a list-scoped grant." };
  }
  if (companyScope === "list" && (!companyIds || companyIds.length === 0)) {
    return { ok: false, error: "Pick at least one company for a list-scoped grant." };
  }

  const [row] = await withGrantScope(actorId, "super_admin", (tx) =>
    tx
      .insert(roleGrant)
      .values({
        userId: input.userId,
        role: input.role,
        deptScope,
        departmentIds: deptScope === "list" ? departmentIds : null,
        companyScope,
        companyIds: companyScope === "list" ? companyIds : null,
        grantedBy: actorId,
      })
      .returning({ id: roleGrant.id }),
  );

  return { ok: true, id: row.id };
}

export type RevokeGrantResult = { ok: true } | { ok: false; error: string };

export async function revokeGrant(actorId: string, grantId: string): Promise<RevokeGrantResult> {
  const [row] = await withGrantScope(actorId, "super_admin", (tx) =>
    tx
      .update(roleGrant)
      .set({ revokedAt: new Date() })
      .where(and(eq(roleGrant.id, grantId), isNull(roleGrant.revokedAt)))
      .returning({ id: roleGrant.id }),
  );

  if (!row) return { ok: false, error: "That grant is already revoked, or doesn't exist." };
  return { ok: true };
}

// Distinct from revokeGrant: a specific role_grant takes effect on the
// actor's very next withGrantScope call regardless (assertActiveGrant
// re-checks fresh every time, src/db/runtime.ts) — no session needs
// killing for a revoked grant to stop working. This is the harder,
// separate lever: log the user out of every active session right now,
// e.g. on suspected compromise. Wraps a real primitive
// (src/auth/sessionStore.ts) that already existed but nothing called.
export async function forceSignOut(actorId: string, userId: string): Promise<void> {
  await revokeAllSessionsForUser(actorId, userId);
}
