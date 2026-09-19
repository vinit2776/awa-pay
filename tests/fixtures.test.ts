import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashSecret } from "../src/auth/password";
import { closeOwnerConnection, dbOwner } from "../scripts/db-owner";
import { dbIdentity, requireTestUrls } from "../scripts/dbTarget";
import { cleanupFixturesForNonce, findFixtures } from "../scripts/fixtures";
import { comment, company, department, duplicateCheck, headOfAccount, request, roleGrant, user, vendor } from "../src/db/schema";

// Gate for the test-isolation machinery itself: the nonce-based fixture
// cleanup every other test file's afterAll now depends on, and the guard
// that keeps the suite off the dev database. Runs against the test
// database like everything else here.

const familyNonce = randomUUID().slice(0, 8);
const entangledNonce = randomUUID().slice(0, 8);
const controlEmail = `fixtures-control-${familyNonce}@awa-pay.test`;

async function makeUser(email: string) {
  const [u] = await dbOwner.insert(user).values({ name: `Fixtures Test ${email}`, email, passwordHash: await hashSecret("unused") }).returning({ id: user.id });
  return u;
}

async function activeGrantsOf(userId: string) {
  const rows = await dbOwner.select({ revokedAt: roleGrant.revokedAt }).from(roleGrant).where(eq(roleGrant.userId, userId));
  return rows.filter((r) => r.revokedAt === null).length;
}

afterAll(async () => {
  try {
    const [control] = await dbOwner.select({ id: user.id }).from(user).where(eq(user.email, controlEmail));
    if (control) {
      await dbOwner.delete(roleGrant).where(eq(roleGrant.userId, control.id));
      await dbOwner.delete(user).where(eq(user.id, control.id));
    }
    // Belt and braces for a failed assertion half-way through: whatever these
    // two families still hold, the same helper clears (or, if the test's
    // deliberate entanglement is still in place, throws — which is correct).
    await dbOwner.delete(vendor).where(eq(vendor.name, `Entangled Vendor ${entangledNonce}x`));
    await cleanupFixturesForNonce(dbOwner, familyNonce);
    await cleanupFixturesForNonce(dbOwner, entangledNonce);
  } finally {
    await closeOwnerConnection();
  }
});

describe("fixture cleanup (nonce-based purge)", () => {
  let controlUserId: string;

  beforeAll(async () => {
    controlUserId = (await makeUser(controlEmail)).id;
    await dbOwner.insert(roleGrant).values({ userId: controlUserId, role: "approver", deptScope: "global", grantedBy: controlUserId });
  });

  it("removes a whole fixture family — including comment and duplicate_check rows, which the old hand-written lists missed — and leaves a protected walkthrough-style user alone", async () => {
    const requester = await makeUser(`fixtures-test-requester-${familyNonce}@example.invalid`);
    const accountant = await makeUser(`fixtures-test-accountant-${familyNonce}@example.invalid`);
    const [dept] = await dbOwner.insert(department).values({ name: `Fixtures Test Dept ${familyNonce}`, code: `FXT-${familyNonce}`, ageingThresholdDays: 30 }).returning({ id: department.id });
    const [co] = await dbOwner.insert(company).values({ name: `Fixtures Test Co ${familyNonce}`, legalName: `Fixtures Test Co ${familyNonce} Pvt Ltd` }).returning({ id: company.id });
    const [head] = await dbOwner.insert(headOfAccount).values({ name: `Fixtures Test Head ${familyNonce}`, code: `FXT-H-${familyNonce}` }).returning({ id: headOfAccount.id });
    const [vend] = await dbOwner.insert(vendor).values({ name: `Fixtures Test Vendor ${familyNonce}`, createdBy: accountant.id }).returning({ id: vendor.id });
    await dbOwner.insert(roleGrant).values([
      { userId: requester.id, role: "requester", deptScope: "list", departmentIds: [dept.id], grantedBy: requester.id },
      { userId: accountant.id, role: "accountant", deptScope: "global", companyScope: "global", grantedBy: accountant.id },
    ]);
    const [r1, r2] = await dbOwner
      .insert(request)
      .values([
        { ref: `FX-${familyNonce}-1`, departmentId: dept.id, raisedBy: requester.id, amountMinor: 100 },
        { ref: `FX-${familyNonce}-2`, departmentId: dept.id, raisedBy: requester.id, amountMinor: 100 },
      ])
      .returning({ id: request.id });
    await dbOwner.insert(comment).values({ requestId: r1.id, author: requester.id, roleAtTime: "requester", body: "hello" });
    await dbOwner.insert(duplicateCheck).values({ requestId: r2.id, matchedRequestId: r1.id, signals: ["vendor_invoice_fy"], score: 1, verdict: "warned_open" });

    const found = await findFixtures(dbOwner, { nonce: familyNonce });
    expect(found.users.map((u) => u.id).sort()).toEqual([requester.id, accountant.id].sort());
    expect(found.requests).toHaveLength(2);
    expect(found.foreignRequests).toHaveLength(0);

    await cleanupFixturesForNonce(dbOwner, familyNonce);

    expect(await dbOwner.select({ id: user.id }).from(user).where(inArray(user.id, [requester.id, accountant.id]))).toHaveLength(0);
    expect(await dbOwner.select({ id: request.id }).from(request).where(inArray(request.id, [r1.id, r2.id]))).toHaveLength(0);
    expect(await dbOwner.select({ id: department.id }).from(department).where(eq(department.id, dept.id))).toHaveLength(0);
    expect(await dbOwner.select({ id: company.id }).from(company).where(eq(company.id, co.id))).toHaveLength(0);
    expect(await dbOwner.select({ id: headOfAccount.id }).from(headOfAccount).where(eq(headOfAccount.id, head.id))).toHaveLength(0);
    expect(await dbOwner.select({ id: vendor.id }).from(vendor).where(eq(vendor.id, vend.id))).toHaveLength(0);

    // Carries the family's nonce in its email but not the fixture shape, so it must survive.
    expect(await dbOwner.select({ id: user.id }).from(user).where(eq(user.id, controlUserId))).toHaveLength(1);
    expect(await activeGrantsOf(controlUserId)).toBe(1);
  });

  it("fails loudly when something real still references a fixture — and has already revoked the fixture's grants by then", async () => {
    const accountant = await makeUser(`fixtures-test-accountant-${entangledNonce}@example.invalid`);
    await dbOwner.insert(roleGrant).values({ userId: accountant.id, role: "accountant", deptScope: "global", companyScope: "global", grantedBy: accountant.id });
    // Not fixture-named (no nonce), so the purge can't select it — but it
    // references the fixture user, which is exactly the case where a plain
    // delete of the user must fail rather than orphan or destroy real data.
    await dbOwner.insert(vendor).values({ name: `Entangled Vendor ${entangledNonce}x`, createdBy: accountant.id });
    expect(await activeGrantsOf(accountant.id)).toBe(1);

    await expect(cleanupFixturesForNonce(dbOwner, entangledNonce)).rejects.toThrow(/FIXTURE CLEANUP FAILED/);

    // The part that matters for notifications: dead grants, even though the delete failed.
    expect(await activeGrantsOf(accountant.id)).toBe(0);
    expect(await dbOwner.select({ id: user.id }).from(user).where(eq(user.id, accountant.id))).toHaveLength(1);

    // Un-entangle and the same call succeeds — the failure left nothing half-deleted.
    await dbOwner.delete(vendor).where(eq(vendor.name, `Entangled Vendor ${entangledNonce}x`));
    await cleanupFixturesForNonce(dbOwner, entangledNonce);
    expect(await dbOwner.select({ id: user.id }).from(user).where(eq(user.id, accountant.id))).toHaveLength(0);
  });

  it("refuses a malformed nonce rather than building a regex from it", async () => {
    await expect(findFixtures(dbOwner, { nonce: ".*" })).rejects.toThrow(/malformed fixture nonce/);
  });
});

describe("test-database isolation guard", () => {
  it("identifies a Supabase project by ref across pooler and direct URLs, and different projects as different", () => {
    const pooledRuntime = "postgres://app_runtime.abcdefgh:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres";
    const pooledOwner = "postgres://postgres.abcdefgh:pw@aws-0-ap-south-1.pooler.supabase.com:5432/postgres";
    const direct = "postgres://postgres:pw@db.abcdefgh.supabase.co:5432/postgres";
    const other = "postgres://app_runtime.zzzzzzzz:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres";
    expect(dbIdentity(pooledRuntime)).toBe(dbIdentity(pooledOwner));
    expect(dbIdentity(pooledRuntime)).toBe(dbIdentity(direct));
    expect(dbIdentity(pooledRuntime)).not.toBe(dbIdentity(other));
  });

  it("refuses to run when a test URL names the same database as a dev URL, even with a different password or role", () => {
    // setup.ts has already parked the real dev values and pointed
    // DATABASE_URL at the test database, so the parked snapshot is what a
    // dev URL looks like from in here — swap it for one that is the test
    // database in different clothes.
    const snapshotVars = ["AWA_PRE_TEST_DATABASE_URL", "AWA_PRE_TEST_DATABASE_URL_MIGRATIONS"] as const;
    const saved = snapshotVars.map((k) => process.env[k]);
    try {
      const sameDb = new URL(process.env.DATABASE_URL_TEST!);
      sameDb.password = "a-different-password";
      process.env.AWA_PRE_TEST_DATABASE_URL = sameDb.toString();
      expect(() => requireTestUrls()).toThrow(/same database as DATABASE_URL /);
      process.env.AWA_PRE_TEST_DATABASE_URL = saved[0];
      process.env.AWA_PRE_TEST_DATABASE_URL_MIGRATIONS = sameDb.toString();
      expect(() => requireTestUrls()).toThrow(/same database as DATABASE_URL_MIGRATIONS/);
    } finally {
      snapshotVars.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k];
        else process.env[k] = saved[i];
      });
    }
    expect(() => requireTestUrls()).not.toThrow();
  });

  it("fails closed when a test URL is missing instead of falling back to the dev URL", () => {
    const saved = process.env.DATABASE_URL_TEST;
    try {
      delete process.env.DATABASE_URL_TEST;
      expect(() => requireTestUrls()).toThrow(/DATABASE_URL_TEST not set/);
    } finally {
      process.env.DATABASE_URL_TEST = saved;
    }
  });
});
