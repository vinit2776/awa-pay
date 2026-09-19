import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeOwnerConnection, dbOwner } from "../scripts/db-owner";
import { cleanupFixturesForNonce } from "../scripts/fixtures";
import { __unscopedRuntimeConnectionForGateTestOnly, withGrantScope } from "../src/db/runtime";
import { department, request, roleGrant, user } from "../src/db/schema";

// The gate, per docs/START-HERE.md phase 1: proves an unscoped query as the
// runtime role returns nothing even when matching rows exist, and that a
// scoped query returns exactly the right rows and none of the wrong ones.
// Do not proceed to phase 2 until this is green.
//
// Seeds fixtures directly via the owner role (dbOwner), bypassing RLS on
// purpose, then exercises the app_runtime path through the real
// src/db/runtime.ts — not a parallel test-only client — so a misconfigured
// real runtime path fails this test rather than passing next to a broken
// one. Runs against the real, already-provisioned Supabase dev project;
// fixtures carry a per-run nonce and clean up in afterAll.

const nonce = crypto.randomUUID().slice(0, 8);

let deptA: { id: string };
let deptB: { id: string };
let requesterUser: { id: string };
let requestA: { id: string };
let requestB: { id: string };

beforeAll(async () => {
  [deptA] = await dbOwner
    .insert(department)
    .values({ name: `Isolation Test Dept A ${nonce}`, code: `ISO-A-${nonce}`, ageingThresholdDays: 30 })
    .returning({ id: department.id });

  [deptB] = await dbOwner
    .insert(department)
    .values({ name: `Isolation Test Dept B ${nonce}`, code: `ISO-B-${nonce}`, ageingThresholdDays: 30 })
    .returning({ id: department.id });

  [requesterUser] = await dbOwner
    .insert(user)
    .values({
      name: `Isolation Test Requester ${nonce}`,
      email: `isolation-test-${nonce}@example.invalid`,
      // Not exercised by this test — the isolation gate predates phase 2's
      // auth columns and doesn't care about credentials, just a non-null value.
      passwordHash: "unused-in-isolation-test",
    })
    .returning({ id: user.id });

  await dbOwner.insert(roleGrant).values({
    userId: requesterUser.id,
    role: "requester",
    deptScope: "list",
    departmentIds: [deptA.id],
    companyScope: "n/a",
    grantedBy: requesterUser.id,
  });

  [requestA] = await dbOwner
    .insert(request)
    .values({
      ref: `ISO-REQ-A-${nonce}`,
      departmentId: deptA.id,
      raisedBy: requesterUser.id,
      amountMinor: 10000,
    })
    .returning({ id: request.id });

  [requestB] = await dbOwner
    .insert(request)
    .values({
      ref: `ISO-REQ-B-${nonce}`,
      departmentId: deptB.id,
      raisedBy: requesterUser.id,
      amountMinor: 10000,
    })
    .returning({ id: request.id });
});

afterAll(async () => {
  try {
    await cleanupFixturesForNonce(dbOwner, nonce);
  } finally {
    await closeOwnerConnection();
  }
});

describe("row-level security isolation (the gate)", () => {
  it("an unscoped query as app_runtime returns nothing, even though matching rows exist", async () => {
    const ownerCount = await dbOwner
      .select({ id: request.id })
      .from(request)
      .where(inArray(request.id, [requestA.id, requestB.id]));
    expect(ownerCount).toHaveLength(2); // the rows genuinely exist

    const unscoped = await __unscopedRuntimeConnectionForGateTestOnly((tx) =>
      tx.select({ id: request.id }).from(request).where(inArray(request.id, [requestA.id, requestB.id])),
    );
    expect(unscoped).toHaveLength(0);
  });

  it("a scoped query returns exactly the right rows and none of the wrong ones", async () => {
    const scoped = await withGrantScope(requesterUser.id, "requester", (tx) =>
      tx.select({ id: request.id }).from(request).where(inArray(request.id, [requestA.id, requestB.id])),
    );

    const scopedIds = scoped.map((r) => r.id);
    expect(scopedIds).toContain(requestA.id);
    expect(scopedIds).not.toContain(requestB.id);
    expect(scopedIds).toHaveLength(1);
  });
});
