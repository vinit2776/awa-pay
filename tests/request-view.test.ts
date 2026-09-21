import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeOwnerConnection, dbOwner } from "../scripts/db-owner";
import { cleanupFixturesForNonce } from "../scripts/fixtures";
import { withGrantScope } from "../src/db/runtime";
import { accounting, comment, department, event, query, request, requestFile, roleGrant, user } from "../src/db/schema";
import { loadRequestView } from "../src/requests/requestView";
import { resolveViewerRole } from "../src/requests/viewerRole";

// src/requests/requestView.ts replaced ~10 separate scoped transactions (a
// probe per role, one for the reads, one each for role-specific extras)
// with one transaction and one relational statement. This proves the
// consolidation returns exactly what the separate, individually-scoped
// queries it replaced returned — same rows, same order, same joined names —
// and that role resolution still lets RLS decide visibility (an approver of
// another department, and a person with no grants, get nothing).
// Runs against the real dev project like every other file here.

const nonce = randomUUID().slice(0, 8);

let deptA: { id: string };
let deptB: { id: string };
let requester: { id: string };
let approver: { id: string };
let dualRole: { id: string };
let outsiderApprover: { id: string };
let noGrants: { id: string };
let requestId: string;

async function makeUser(label: string): Promise<{ id: string }> {
  const [u] = await dbOwner
    .insert(user)
    .values({ name: `ReqView ${label} ${nonce}`, email: `reqview-${label}-${nonce}@example.invalid`, passwordHash: "unused-in-request-view-test" })
    .returning({ id: user.id });
  return u;
}

async function grant(userId: string, role: string, deptId: string) {
  await dbOwner.insert(roleGrant).values({
    userId,
    role: role as (typeof roleGrant.$inferInsert)["role"],
    deptScope: "list",
    departmentIds: [deptId],
    companyScope: "n/a",
    grantedBy: userId,
  });
}

beforeAll(async () => {
  [deptA] = await dbOwner.insert(department).values({ name: `ReqView A ${nonce}`, code: `RV-A-${nonce}`, ageingThresholdDays: 30 }).returning({ id: department.id });
  [deptB] = await dbOwner.insert(department).values({ name: `ReqView B ${nonce}`, code: `RV-B-${nonce}`, ageingThresholdDays: 30 }).returning({ id: department.id });
  requester = await makeUser("requester");
  approver = await makeUser("approver");
  dualRole = await makeUser("dual");
  outsiderApprover = await makeUser("outsider");
  noGrants = await makeUser("none");
  await grant(requester.id, "requester", deptA.id);
  await grant(approver.id, "approver", deptA.id);
  await grant(dualRole.id, "requester", deptA.id);
  await grant(dualRole.id, "approver", deptA.id);
  await grant(outsiderApprover.id, "approver", deptB.id);

  const [req] = await dbOwner
    .insert(request)
    .values({ ref: `RV-${nonce}`, departmentId: deptA.id, raisedBy: requester.id, amountMinor: 123400, vendor: "ReqView Vendor" })
    .returning({ id: request.id });
  requestId = req.id;

  const sha = () => randomUUID().replaceAll("-", "").padEnd(64, "0");
  // Inserted out of page order on purpose: the view must sort bills by pageNo.
  await dbOwner.insert(requestFile).values([
    { requestId, kind: "bill", pageNo: 2, storageKey: `reqview/${nonce}/p2`, mime: "application/pdf", bytes: 4, sha256: sha(), uploadedBy: requester.id },
    { requestId, kind: "bill", pageNo: 1, storageKey: `reqview/${nonce}/p1`, mime: "application/pdf", bytes: 4, sha256: sha(), uploadedBy: requester.id },
  ]);

  const h1 = randomUUID().replaceAll("-", "").padEnd(64, "a");
  const h2 = randomUUID().replaceAll("-", "").padEnd(64, "b");
  await dbOwner.insert(event).values([
    { requestId, actor: requester.id, roleAtTime: "requester", type: "request.raised", objectType: "request", objectId: requestId, after: { stage: "raised", nested: { n: 1 } }, hash: h1, prevHash: null, at: new Date("2026-01-01T10:00:00.123Z") },
    { requestId, actor: approver.id, roleAtTime: "approver", type: "request.returned", objectType: "request", objectId: requestId, before: { stage: "awaiting_approval" }, reason: "why", hash: h2, prevHash: h1, at: new Date("2026-01-02T10:00:00.456Z") },
  ]);

  const [c] = await dbOwner
    .insert(comment)
    .values({ requestId, author: approver.id, roleAtTime: "approver", body: "a comment", mentions: [requester.id] })
    .returning({ id: comment.id });
  await dbOwner.insert(requestFile).values({
    requestId,
    kind: "comment_attachment",
    commentId: c.id,
    storageKey: `reqview/${nonce}/c1`,
    mime: "image/jpeg",
    bytes: 4,
    sha256: sha(),
    uploadedBy: approver.id,
  });

  await dbOwner.insert(query).values([
    { requestId, raisedBy: approver.id, raisedAsRole: "approver", directedAt: ["requester"], question: "open one" },
    {
      requestId,
      raisedBy: approver.id,
      raisedAsRole: "approver",
      directedAt: ["requester"],
      question: "resolved one",
      answeredBy: requester.id,
      answeredAsRole: "requester",
      answer: "yes",
      resolvedAt: new Date(),
    },
  ]);
});

afterAll(async () => {
  try {
    await cleanupFixturesForNonce(dbOwner, nonce);
  } finally {
    await closeOwnerConnection();
  }
});

// The exact reads the page made before, one query each, as the oracle.
async function separateQueries(userId: string, role: "requester" | "approver") {
  return withGrantScope(userId, role, async (tx) => ({
    dept: (await tx.select().from(department).where(eq(department.id, deptA.id)))[0],
    bills: await tx.select().from(requestFile).where(and(eq(requestFile.requestId, requestId), eq(requestFile.kind, "bill"))).orderBy(asc(requestFile.pageNo)),
    attachments: await tx.select().from(requestFile).where(and(eq(requestFile.requestId, requestId), eq(requestFile.kind, "comment_attachment"))).orderBy(asc(requestFile.createdAt)),
    events: await tx.select({ event, actorName: user.name }).from(event).leftJoin(user, eq(user.id, event.actor)).where(eq(event.requestId, requestId)).orderBy(asc(event.at)),
    comments: await tx.select({ comment, authorName: user.name }).from(comment).leftJoin(user, eq(user.id, comment.author)).where(eq(comment.requestId, requestId)).orderBy(asc(comment.at)),
    openQueries: await tx
      .select({ query, raisedByName: user.name })
      .from(query)
      .leftJoin(user, eq(user.id, query.raisedBy))
      .where(and(eq(query.requestId, requestId), isNull(query.resolvedAt)))
      .orderBy(asc(query.at)),
    accounting: await tx.select().from(accounting).where(eq(accounting.requestId, requestId)).orderBy(desc(accounting.accountedAt)),
  }));
}

describe("loadRequestView: one transaction, same answers as the separate queries", () => {
  for (const [label, getUser, role] of [
    ["the requester", () => requester, "requester"],
    ["the approver", () => approver, "approver"],
  ] as const) {
    it(`returns exactly what separate scoped queries return, for ${label}`, async () => {
      const view = await loadRequestView(getUser().id, requestId);
      const expected = await separateQueries(getUser().id, role);

      expect(view).not.toBeNull();
      expect(view!.role).toBe(role);
      expect(view!.req.id).toBe(requestId);
      expect(view!.department).toEqual(expected.dept);
      expect(view!.bills).toEqual(expected.bills);
      expect(view!.bills.map((b) => b.pageNo)).toEqual([1, 2]);
      expect(view!.commentAttachments).toEqual(expected.attachments);
      expect(view!.events).toEqual(expected.events);
      expect(view!.events.map((e) => e.actorName)).toEqual([`ReqView requester ${nonce}`, `ReqView approver ${nonce}`]);
      expect(view!.comments).toEqual(expected.comments);
      expect(view!.openQueryRows).toEqual(expected.openQueries);
      expect(view!.openQueryRows).toHaveLength(1);
      expect(view!.openQueryRows[0].query.question).toBe("open one");
      expect(view!.accountingRows).toEqual(expected.accounting);
      expect(view!.payments).toEqual([]);
      // Timestamps round-trip as Dates with sub-second precision intact.
      expect(view!.events[0].event.at).toBeInstanceOf(Date);
      expect(view!.events[0].event.at.toISOString()).toBe("2026-01-01T10:00:00.123Z");
      // The open query and the department threshold both reach the flags.
      expect(view!.flagContext.openQueryRequestIds.has(requestId)).toBe(true);
      expect(view!.flagContext.ageingThresholdByDept.get(deptA.id)).toBe(30);
    });
  }

  it("resolves a multi-role person to the highest-priority role that can see the request", async () => {
    const view = await loadRequestView(dualRole.id, requestId);
    expect(view?.role).toBe("approver");
    const resolved = await resolveViewerRole(dualRole.id, requestId);
    expect(resolved?.role).toBe("approver");
    expect(resolved?.request.id).toBe(requestId);
  });

  it("lets RLS decide: another department's approver, and a person with no grants, see nothing", async () => {
    expect(await loadRequestView(outsiderApprover.id, requestId)).toBeNull();
    expect(await loadRequestView(noGrants.id, requestId)).toBeNull();
    expect(await resolveViewerRole(outsiderApprover.id, requestId)).toBeNull();
    expect(await resolveViewerRole(noGrants.id, requestId)).toBeNull();
  });

  it("does not need the caller to supply a role at all (nothing to spoof)", async () => {
    // A requester-only person is never resolved to a role they don't hold,
    // even though approver outranks requester in the priority list.
    const view = await loadRequestView(requester.id, requestId);
    expect(view?.role).toBe("requester");
    expect(view?.canOverrideDuplicate).toBe(false);
  });
});
