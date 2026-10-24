import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashSecret } from "../src/auth/password";
import { insertSession } from "../src/auth/sessionStore";
import { forceSignOut, getUserWithGrants, grantRole, listUsers, revokeGrant } from "../src/admin/roleGrantCore";
import { closeOwnerConnection, dbOwner } from "../scripts/db-owner";
import { cleanupFixturesForNonce } from "../scripts/fixtures";
import { UnauthorizedGrantError, withGrantScope } from "../src/db/runtime";
import { department, roleGrant, session, user } from "../src/db/schema";

// Gate test for the admin console (src/admin/roleGrantCore.ts) — exercises
// the real dev Supabase project like every other *.test.ts here, no
// mocks. Not attempted here (browser-only): GrantForm.tsx's role-based
// field visibility, the checkbox pickers themselves.

const nonce = randomUUID().slice(0, 8);
const META = { ip: "203.0.113.40", userAgent: "vitest" };

let deptA: { id: string };
let superAdmin: { id: string };
let plainUser: { id: string };
let targetUser: { id: string };

async function makeUser(label: string): Promise<{ id: string }> {
  const [u] = await dbOwner
    .insert(user)
    .values({ name: `Admin Test ${label} ${nonce}`, email: `admin-test-${label}-${nonce}@example.invalid`, passwordHash: await hashSecret("unused") })
    .returning({ id: user.id });
  return u;
}

async function grant(userId: string, role: string, opts: { deptIds?: string[] } = {}) {
  await dbOwner.insert(roleGrant).values({
    userId,
    role: role as (typeof roleGrant.$inferInsert)["role"],
    deptScope: opts.deptIds ? "list" : "global",
    departmentIds: opts.deptIds,
    grantedBy: userId,
  });
}

beforeAll(async () => {
  [deptA] = await dbOwner.insert(department).values({ name: `Admin Test Dept A ${nonce}`, code: `ADM-A-${nonce}`, ageingThresholdDays: 30 }).returning({ id: department.id });

  superAdmin = await makeUser("super-admin");
  plainUser = await makeUser("plain");
  targetUser = await makeUser("target");

  await grant(superAdmin.id, "super_admin");
});

afterAll(async () => {
  try {
    await cleanupFixturesForNonce(dbOwner, nonce);
  } finally {
    await closeOwnerConnection();
  }
});

describe("role_grant_requester_not_global_check (DB constraint)", () => {
  it("rejects a requester grant with global department scope at the DB layer", async () => {
    await expect(
      dbOwner.insert(roleGrant).values({ userId: targetUser.id, role: "requester", deptScope: "global", grantedBy: superAdmin.id }),
    ).rejects.toThrow();
  });
});

describe("grantRole", () => {
  it("rejects requester + global with a friendly error, mirroring the DB constraint", async () => {
    const result = await grantRole(superAdmin.id, {
      userId: targetUser.id,
      role: "requester",
      deptScope: "global",
      departmentIds: [],
      companyScope: "n/a",
      companyIds: [],
    });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("never hold global department scope") });
  });

  it("requires the caller to hold an active super_admin grant", async () => {
    await expect(
      grantRole(plainUser.id, {
        userId: targetUser.id,
        role: "approver",
        deptScope: "global",
        departmentIds: [],
        companyScope: "n/a",
        companyIds: [],
      }),
    ).rejects.toThrow(UnauthorizedGrantError);
  });
});

describe("grant / revoke round-trip", () => {
  it("takes effect immediately, both ways, with no session re-login needed", async () => {
    const granted = await grantRole(superAdmin.id, {
      userId: targetUser.id,
      role: "approver",
      deptScope: "list",
      departmentIds: [deptA.id],
      companyScope: "n/a",
      companyIds: [],
    });
    expect(granted.ok).toBe(true);

    await expect(withGrantScope(targetUser.id, "approver", async () => true)).resolves.toBe(true);

    const revoked = await revokeGrant(superAdmin.id, (granted as { ok: true; id: string }).id);
    expect(revoked).toEqual({ ok: true });

    await expect(withGrantScope(targetUser.id, "approver", async () => true)).rejects.toThrow(UnauthorizedGrantError);
  });

  it("reports an already-revoked grant as an error rather than silently no-op'ing", async () => {
    const granted = await grantRole(superAdmin.id, {
      userId: targetUser.id,
      role: "accountant",
      deptScope: "global",
      departmentIds: [],
      companyScope: "global",
      companyIds: [],
    });
    const grantId = (granted as { ok: true; id: string }).id;
    await revokeGrant(superAdmin.id, grantId);
    const second = await revokeGrant(superAdmin.id, grantId);
    expect(second.ok).toBe(false);
  });
});

describe("listUsers / getUserWithGrants", () => {
  it("finds a user by a partial, case-insensitive name/email match, super_admin-only", async () => {
    const found = await listUsers(superAdmin.id, `admin-test-target-${nonce}`.toUpperCase());
    expect(found.map((u) => u.id)).toContain(targetUser.id);

    await expect(listUsers(plainUser.id)).rejects.toThrow(UnauthorizedGrantError);
  });

  it("returns full grant history for a user, active and revoked", async () => {
    const detail = await getUserWithGrants(superAdmin.id, targetUser.id);
    expect(detail?.user.id).toBe(targetUser.id);
    expect(detail?.grants.some((g) => g.revokedAt !== null)).toBe(true);
  });
});

describe("forceSignOut", () => {
  it("revokes every active session for the target user right now", async () => {
    await insertSession(targetUser.id, "active", META);

    const before = await dbOwner.select().from(session).where(eq(session.userId, targetUser.id));
    expect(before.some((s) => s.revokedAt === null)).toBe(true);

    await forceSignOut(superAdmin.id, targetUser.id);

    const after = await dbOwner.select().from(session).where(eq(session.userId, targetUser.id));
    expect(after.every((s) => s.revokedAt !== null)).toBe(true);
  });

  it("requires the caller to hold an active super_admin grant", async () => {
    await expect(forceSignOut(plainUser.id, targetUser.id)).rejects.toThrow(UnauthorizedGrantError);
  });
});
