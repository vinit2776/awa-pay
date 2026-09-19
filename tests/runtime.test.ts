import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeOwnerConnection, dbOwner } from "../scripts/db-owner";
import {
  UnauthorizedGrantError,
  withActorScope,
  withGrantScope,
  withPreAuthLookup,
  withPresentedSessionToken,
  withViewerRole,
} from "../src/db/runtime";
import { department, request, roleGrant, user } from "../src/db/schema";

// src/db/runtime.ts sends BEGIN, the scope GUCs and the grant check as one
// parameter-free multi-statement message, and starts the caller's function
// alongside it instead of after it. These tests pin down what that must
// never change: a role is only ever bound when the database has proven a
// live grant (fail closed even though fn is already running), caller-
// supplied text can't escape the literals it is inlined into, and one
// person's scope can't leak into the next transaction on a pooled
// connection. tests/isolation.test.ts remains the gate for the basic
// scoped/unscoped behaviour.

const nonce = randomUUID().slice(0, 8);

let dept: { id: string };
let holder: { id: string }; // requester grant, active
let revoked: { id: string }; // requester grant, revoked
let nobody: { id: string }; // no grants at all
let requestId: string;

async function makeUser(label: string): Promise<{ id: string }> {
  const [u] = await dbOwner
    .insert(user)
    .values({ name: `Runtime ${label} ${nonce}`, email: `runtime-${label}-${nonce}@example.invalid`, passwordHash: "unused-in-runtime-test" })
    .returning({ id: user.id });
  return u;
}

beforeAll(async () => {
  [dept] = await dbOwner.insert(department).values({ name: `Runtime Dept ${nonce}`, code: `RT-${nonce}`, ageingThresholdDays: 30 }).returning({ id: department.id });
  holder = await makeUser("holder");
  revoked = await makeUser("revoked");
  nobody = await makeUser("nobody");

  for (const [u, revokedAt] of [
    [holder, null],
    [revoked, new Date()],
  ] as const) {
    await dbOwner.insert(roleGrant).values({
      userId: u.id,
      role: "requester",
      deptScope: "list",
      departmentIds: [dept.id],
      companyScope: "n/a",
      grantedBy: u.id,
      revokedAt,
    });
  }

  const [req] = await dbOwner.insert(request).values({ ref: `RT-${nonce}`, departmentId: dept.id, raisedBy: holder.id, amountMinor: 1000 }).returning({ id: request.id });
  requestId = req.id;
});

afterAll(async () => {
  const userIds = [holder.id, revoked.id, nobody.id];
  await dbOwner.delete(request).where(eq(request.id, requestId));
  await dbOwner.delete(roleGrant).where(inArray(roleGrant.userId, userIds));
  await dbOwner.delete(department).where(eq(department.id, dept.id));
  await dbOwner.delete(user).where(inArray(user.id, userIds));
  await closeOwnerConnection();
});

describe("withGrantScope binds a role only when a live grant exists", () => {
  it("throws UnauthorizedGrantError for a role the actor never held — including super_admin", async () => {
    await expect(withGrantScope(nobody.id, "requester", async () => "ran")).rejects.toBeInstanceOf(UnauthorizedGrantError);
    await expect(withGrantScope(holder.id, "super_admin", async () => "ran")).rejects.toBeInstanceOf(UnauthorizedGrantError);
    await expect(withGrantScope(holder.id, "developer", async () => "ran")).rejects.toBeInstanceOf(UnauthorizedGrantError);
  });

  it("throws for a revoked grant", async () => {
    await expect(withGrantScope(revoked.id, "requester", async () => "ran")).rejects.toBeInstanceOf(UnauthorizedGrantError);
  });

  it("fails closed even though fn is already running when the verdict arrives: an unheld super_admin sees nothing", async () => {
    // super_admin's RLS policies grant blanket access to whoever the role
    // GUC names, so if the role were bound before the grant was proven this
    // read would return the request. It must come back empty, and the call
    // must still be rejected with the courtesy error.
    let seen: { id: string }[] | null = null;
    await expect(
      withGrantScope(holder.id, "super_admin", async (tx) => {
        seen = await tx.select({ id: request.id }).from(request).where(eq(request.id, requestId));
        return seen;
      }),
    ).rejects.toBeInstanceOf(UnauthorizedGrantError);
    expect(seen).toEqual([]);

    // Sanity: the same read under the role the actor does hold finds it.
    const asRequester = await withGrantScope(holder.id, "requester", (tx) => tx.select({ id: request.id }).from(request).where(eq(request.id, requestId)));
    expect(asRequester).toHaveLength(1);
  });

  it("rolls back whatever fn wrote when the grant check fails", async () => {
    const before = await dbOwner.select({ id: department.id }).from(department).where(eq(department.id, dept.id));
    expect(before).toHaveLength(1);
    await expect(
      withGrantScope(nobody.id, "requester", async (tx) => {
        // Denied by RLS or rolled back — either way it must not persist.
        await tx.update(request).set({ note: "written by an unauthorized scope" }).where(eq(request.id, requestId)).catch(() => undefined);
      }),
    ).rejects.toBeInstanceOf(UnauthorizedGrantError);
    const [row] = await dbOwner.select({ note: request.note }).from(request).where(eq(request.id, requestId));
    expect(row.note).toBeNull();
  });

  it("rejects a malformed actor id or an unknown role before touching the database", async () => {
    await expect(withGrantScope("not-a-uuid", "requester", async () => "ran")).rejects.toThrow("Expected a UUID");
    await expect(withGrantScope(holder.id, "'; drop table request; --" as never, async () => "ran")).rejects.toThrow("Unknown role");
    await expect(withActorScope("1' or '1'='1", async () => "ran")).rejects.toThrow("Expected a UUID");
  });
});

describe("scope values can't escape the SQL they're inlined into", () => {
  const hostile = `o'brien"; select pg_sleep(0); -- \\ \\' $$ ü 日本 \n\t`;

  it("round-trips arbitrary text through the pre-auth GUCs exactly", async () => {
    const [row] = await withPreAuthLookup({ email: hostile, clientIp: `1.2.3.4' or '1'='1` }, (tx) =>
      tx.execute<{ email: string; ip: string }>(sql`select current_setting('app.presented_login_email', true) as email, current_setting('app.presented_client_ip', true) as ip`),
    );
    expect(row.email).toBe(hostile);
    expect(row.ip).toBe(`1.2.3.4' or '1'='1`);
  });

  it("round-trips a token hash through withPresentedSessionToken", async () => {
    const [row] = await withPresentedSessionToken(hostile, (tx) => tx.execute<{ v: string }>(sql`select current_setting('app.presented_token_hash', true) as v`));
    expect(row.v).toBe(hostile);
  });
});

describe("one person's scope never leaks into the next transaction", () => {
  it("leaves no GUC behind on a pooled connection", async () => {
    for (let i = 0; i < 6; i++) {
      await withGrantScope(holder.id, "requester", (tx) => tx.select({ id: request.id }).from(request).where(eq(request.id, requestId)));
    }
    // Same pool, different person: nothing of the previous scope survives.
    const leaked = await withActorScope(nobody.id, (tx) =>
      tx.execute<{ actor: string | null; role: string | null }>(sql`select current_setting('app.actor_id', true) as actor, current_setting('app.actor_role', true) as role`),
    );
    expect(leaked[0].actor).toBe(nobody.id);
    expect(leaked[0].role === null || leaked[0].role === "").toBe(true);
  });

  it("a failed transaction is rolled back and the connection is reusable", async () => {
    await expect(
      withGrantScope(holder.id, "requester", async (tx) => {
        await tx.execute(sql`select 1/0`);
      }),
    ).rejects.toThrow();
    const rows = await withGrantScope(holder.id, "requester", (tx) => tx.select({ id: request.id }).from(request).where(eq(request.id, requestId)));
    expect(rows).toHaveLength(1);
  });
});

describe("withViewerRole", () => {
  it("only ever tries roles the actor holds, in priority order, and runs fn under the winner", async () => {
    const tried: string[] = [];
    const result = await withViewerRole(
      holder.id,
      ["approver", "accountant", "requester", "super_admin"],
      async (tx) => {
        const [role] = await tx.execute<{ r: string | null }>(sql`select current_setting('app.actor_role', true) as r`);
        tried.push(role.r ?? "");
        return (await tx.select({ id: request.id }).from(request).where(eq(request.id, requestId)))[0];
      },
      async (tx, viewer) => {
        const [role] = await tx.execute<{ r: string }>(sql`select current_setting('app.actor_role', true) as r`);
        return { boundInFn: role.r, resolved: viewer.role, held: [...viewer.heldRoles] };
      },
    );
    // approver/accountant/super_admin aren't held: never bound, never probed.
    expect(tried).toEqual(["requester"]);
    expect(result).toEqual({ boundInFn: "requester", resolved: "requester", held: ["requester"] });
  });

  it("returns null when no held role can see anything, and for a person with no grants", async () => {
    expect(await withViewerRole(nobody.id, ["requester", "approver"], async (tx) => (await tx.select().from(request).where(eq(request.id, requestId)))[0], async () => "x")).toBeNull();
    expect(await withViewerRole(revoked.id, ["requester"], async (tx) => (await tx.select().from(request).where(eq(request.id, requestId)))[0], async () => "x")).toBeNull();
    expect(await withViewerRole(holder.id, ["requester"], async () => null, async () => "x")).toBeNull();
  });
});
