import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeOwnerConnection, dbOwner } from "../scripts/db-owner";
import { withGrantScope } from "../src/db/runtime";
import { comment, department, event, query, request, requestFile, roleGrant, user } from "../src/db/schema";
import { hashSecret } from "../src/auth/password";
import { answerQuery, raiseQuery } from "../src/conversation/queriesCore";
import { notifyQueryRaised } from "../src/notifications/recipients";
import { submitRequest, type Attachment } from "../src/requests/captureCore";
import { resubmit } from "../src/requests/resubmitCore";
import { approveRequest, returnRequestToRequester, withdrawRequest } from "../src/requests/transitions";
import { presignPutUrl } from "../src/storage/r2";
import { buildStorageKey } from "../src/storage/storageKey";

// The phase-6 gate. Same philosophy as tests/{desks,comments}.test.ts:
// exercises the real queriesCore.ts/transitions.ts against the real dev
// Supabase project and real R2, no mocks. Explicitly browser-only, NOT
// attempted here: the query composer's and answer form's visual layout,
// a full click-through raise -> freeze -> answer -> unfreeze walkthrough
// through real forms.

const nonce = randomUUID().slice(0, 8);
const META = { ip: "203.0.113.30", userAgent: "vitest" };

async function uploadTestFile(): Promise<Attachment> {
  const fileId = randomUUID();
  const mime = "application/pdf";
  const storageKey = buildStorageKey("bills", fileId, mime);
  const uploadUrl = await presignPutUrl(storageKey, mime);
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  const response = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": mime }, body: bytes });
  if (!response.ok) throw new Error(`Test fixture upload failed: ${response.status}`);
  return { fileId, storageKey, mime, byteLength: bytes.length, sha256: randomUUID().padEnd(64, "0") };
}

let deptA: { id: string };
let deptB: { id: string };

let requesterUser: { id: string; email: string };
let approverUser: { id: string };
let approverUserB: { id: string }; // deptB — out of scope
let requesterUser2: { id: string; email: string }; // deptA, did not raise the bill
let accountantUser: { id: string; email: string };
let revokedApprover: { id: string }; // had a deptA grant, since revoked

async function grant(userId: string, role: string, opts: { deptIds?: string[] } = {}) {
  await dbOwner.insert(roleGrant).values({
    userId,
    role: role as (typeof roleGrant.$inferInsert)["role"],
    deptScope: opts.deptIds ? "list" : "global",
    departmentIds: opts.deptIds,
    companyScope: "n/a",
    grantedBy: userId,
  });
}

async function makeUser(label: string): Promise<{ id: string; email: string }> {
  const [u] = await dbOwner
    .insert(user)
    .values({ name: `Queries Test ${label} ${nonce}`, email: `queries-test-${label}-${nonce}@example.invalid`, passwordHash: await hashSecret("unused") })
    .returning({ id: user.id, email: user.email });
  return u;
}

async function raiseTestRequest(): Promise<string> {
  const file = await uploadTestFile();
  const result = await submitRequest({
    userId: requesterUser.id,
    ip: META.ip,
    userAgent: META.userAgent,
    departmentId: deptA.id,
    amountMinor: 75000,
    attachments: [file],
  });
  if (!result.ok) throw new Error(result.error);
  return result.requestId;
}

beforeAll(async () => {
  [deptA] = await dbOwner.insert(department).values({ name: `Queries Test Dept A ${nonce}`, code: `QRY-A-${nonce}`, ageingThresholdDays: 30 }).returning({ id: department.id });
  [deptB] = await dbOwner.insert(department).values({ name: `Queries Test Dept B ${nonce}`, code: `QRY-B-${nonce}`, ageingThresholdDays: 30 }).returning({ id: department.id });

  requesterUser = await makeUser("requester");
  approverUser = await makeUser("approver");
  approverUserB = await makeUser("approver-b");
  requesterUser2 = await makeUser("requester-2");
  accountantUser = await makeUser("accountant");
  revokedApprover = await makeUser("revoked-approver");

  await grant(requesterUser.id, "requester", { deptIds: [deptA.id] });
  await grant(approverUser.id, "approver", { deptIds: [deptA.id] });
  await grant(approverUserB.id, "approver", { deptIds: [deptB.id] });
  await grant(requesterUser2.id, "requester", { deptIds: [deptA.id] });
  await grant(accountantUser.id, "accountant", { deptIds: [deptA.id] });
  await grant(revokedApprover.id, "approver", { deptIds: [deptA.id] });
  await dbOwner.update(roleGrant).set({ revokedAt: new Date() }).where(eq(roleGrant.userId, revokedApprover.id));
});

afterAll(async () => {
  const userIds = [requesterUser.id, approverUser.id, approverUserB.id, requesterUser2.id, accountantUser.id, revokedApprover.id];
  const reqs = await dbOwner.select({ id: request.id }).from(request).where(inArray(request.departmentId, [deptA.id, deptB.id]));
  const reqIds = reqs.map((r) => r.id);
  if (reqIds.length > 0) {
    await dbOwner.delete(comment).where(inArray(comment.requestId, reqIds));
    await dbOwner.delete(query).where(inArray(query.requestId, reqIds));
    await dbOwner.delete(event).where(inArray(event.requestId, reqIds));
    await dbOwner.delete(requestFile).where(inArray(requestFile.requestId, reqIds));
    await dbOwner.delete(request).where(inArray(request.id, reqIds));
  }
  await dbOwner.delete(roleGrant).where(inArray(roleGrant.userId, userIds));
  await dbOwner.delete(department).where(inArray(department.id, [deptA.id, deptB.id]));
  await dbOwner.delete(user).where(inArray(user.id, userIds));
  await closeOwnerConnection();
});

describe("queries freeze the request (the phase-6 gate)", () => {
  it("a request with no open query transitions normally", async () => {
    const requestId = await raiseTestRequest();
    const result = await approveRequest(approverUser.id, requestId, { cycle: "unspecified", dueDate: null, noteToAccountsAndPayer: null }, META);
    expect(result.ok).toBe(true);
  });

  it("an open query freezes every transition, and answering it unfreezes them", async () => {
    const requestId = await raiseTestRequest();

    const raised = await raiseQuery(approverUser.id, requestId, { directedAt: ["requester"], question: "Is this the right department?" }, META);
    expect(raised.ok).toBe(true);
    if (!raised.ok) return;

    const blocked = await approveRequest(approverUser.id, requestId, { cycle: "unspecified", dueDate: null, noteToAccountsAndPayer: null }, META);
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.error).toMatch(/open query/i);

    const answered = await answerQuery(requesterUser.id, requestId, raised.queryId, { answer: "Yes, correct department." }, META);
    expect(answered.ok).toBe(true);

    const unblocked = await approveRequest(approverUser.id, requestId, { cycle: "unspecified", dueDate: null, noteToAccountsAndPayer: null }, META);
    expect(unblocked.ok).toBe(true);
  });

  it("a role not in directedAt cannot answer, even with scope over the request", async () => {
    const requestId = await raiseTestRequest();
    const raised = await raiseQuery(requesterUser.id, requestId, { directedAt: ["approver"], question: "Any update?" }, META);
    expect(raised.ok).toBe(true);
    if (!raised.ok) return;

    // requesterUser has scope over their own request but isn't in
    // directedAt (only "approver" is) — should be refused.
    const attempt = await answerQuery(requesterUser.id, requestId, raised.queryId, { answer: "Trying to answer my own query." }, META);
    expect(attempt.ok).toBe(false);
  });

  it("two concurrent answer attempts on the same query: exactly one succeeds", async () => {
    const requestId = await raiseTestRequest();
    const raised = await raiseQuery(approverUser.id, requestId, { directedAt: ["requester"], question: "Confirm the amount?" }, META);
    expect(raised.ok).toBe(true);
    if (!raised.ok) return;

    const results = await Promise.all([
      answerQuery(requesterUser.id, requestId, raised.queryId, { answer: "Yes." }, META),
      answerQuery(requesterUser.id, requestId, raised.queryId, { answer: "Confirmed." }, META),
    ]);
    const succeeded = results.filter((r) => r.ok);
    expect(succeeded).toHaveLength(1);
  });

  it("an out-of-scope role cannot raise a query and never sees it", async () => {
    const requestId = await raiseTestRequest();
    const attempt = await raiseQuery(approverUserB.id, requestId, { directedAt: ["requester"], question: "Should not work." }, META);
    expect(attempt.ok).toBe(false);

    // Raise a legitimate one from an in-scope actor, then confirm the
    // out-of-scope approver still can't see it.
    await raiseQuery(approverUser.id, requestId, { directedAt: ["requester"], question: "Legit query." }, META);
    const rows = await withGrantScope(approverUserB.id, "approver", (tx) => tx.select().from(query).where(eq(query.requestId, requestId)));
    expect(rows).toHaveLength(0);
  });
});

describe("withdraw", () => {
  it("a returned request can be withdrawn by the requester who raised it", async () => {
    const requestId = await raiseTestRequest();
    await returnRequestToRequester(approverUser.id, requestId, { reason: "Wrong department." }, META);

    const result = await withdrawRequest(requesterUser.id, requestId, META);
    expect(result.ok).toBe(true);

    const [row] = await withGrantScope(requesterUser.id, "requester", (tx) => tx.select({ stage: request.stage }).from(request).where(eq(request.id, requestId)));
    expect(row.stage).toBe("withdrawn");

    const second = await withdrawRequest(requesterUser.id, requestId, META);
    expect(second.ok).toBe(false);
  });

  it("an open query blocks withdraw too, uniformly", async () => {
    const requestId = await raiseTestRequest();
    await returnRequestToRequester(approverUser.id, requestId, { reason: "Wrong amount." }, META);
    await raiseQuery(approverUser.id, requestId, { directedAt: ["requester"], question: "Why the discrepancy?" }, META);

    const result = await withdrawRequest(requesterUser.id, requestId, META);
    expect(result.ok).toBe(false);
  });
});

describe("resubmit works on a request's very first return (the bug fixed this phase)", () => {
  it("resubmitCore.resubmit succeeds immediately after one return, not only after a second", async () => {
    const requestId = await raiseTestRequest();
    await returnRequestToRequester(approverUser.id, requestId, { reason: "Fix the invoice number." }, META);

    const [beforeResubmit] = await withGrantScope(requesterUser.id, "requester", (tx) =>
      tx.select({ stage: request.stage, revision: request.revision }).from(request).where(eq(request.id, requestId)),
    );
    expect(beforeResubmit.stage).toBe("raised");
    expect(beforeResubmit.revision).toBe(1); // confirms this is genuinely a first-time return

    const result = await resubmit({
      userId: requesterUser.id,
      requestId,
      ip: META.ip,
      userAgent: META.userAgent,
      amountMinor: 80000,
      newAttachments: [],
    });
    expect(result.ok).toBe(true);

    const [after] = await withGrantScope(requesterUser.id, "requester", (tx) =>
      tx.select({ stage: request.stage, revision: request.revision }).from(request).where(eq(request.id, requestId)),
    );
    expect(after.stage).toBe("awaiting_approval");
    expect(after.revision).toBe(2);
  });
});

// Slice: a query can name people as well as roles. Everyone with scope can
// still read it (query_select is unchanged); who may ANSWER is decided by
// query_update — role in directed_at, or own id in directed_user_ids.
describe("queries directed at named people", () => {
  const APPROVE = { cycle: "unspecified" as const, dueDate: null, noteToAccountsAndPayer: null };

  it("a named person can answer; a same-role colleague who isn't named cannot, and RLS itself refuses them", { timeout: 300_000 }, async () => {
    const requestId = await raiseTestRequest();
    const raised = await raiseQuery(approverUser.id, requestId, { directedAt: [], directedUserIds: [requesterUser.id], question: "Is this the right vendor?" }, META);
    expect(raised.ok).toBe(true);
    if (!raised.ok) return;

    const [stored] = await dbOwner.select().from(query).where(eq(query.id, raised.queryId));
    expect(stored.directedAt).toEqual([]);
    expect(stored.directedUserIds).toEqual([requesterUser.id]);

    // requesterUser2 has the very same role and department scope but isn't named.
    const refused = await answerQuery(requesterUser2.id, requestId, raised.queryId, { answer: "Not mine to answer." }, META);
    expect(refused.ok).toBe(false);

    // Bypass the application check entirely: the policy alone must refuse.
    const direct = await withGrantScope(requesterUser2.id, "requester", (tx) =>
      tx
        .update(query)
        .set({ answeredBy: requesterUser2.id, answeredAsRole: "requester", answer: "sneaky", resolvedAt: new Date() })
        .where(eq(query.id, raised.queryId))
        .returning({ id: query.id }),
    );
    expect(direct).toHaveLength(0);
    const [stillOpen] = await dbOwner.select().from(query).where(eq(query.id, raised.queryId));
    expect(stillOpen.resolvedAt).toBeNull();

    const answered = await answerQuery(requesterUser.id, requestId, raised.queryId, { answer: "Yes, that vendor." }, META);
    expect(answered.ok).toBe(true);
  });

  it("everyone in scope can read a query, whoever it names", { timeout: 300_000 }, async () => {
    const requestId = await raiseTestRequest();
    const raised = await raiseQuery(approverUser.id, requestId, { directedAt: [], directedUserIds: [requesterUser.id], question: "Visible to all?" }, META);
    expect(raised.ok).toBe(true);

    const seenByOtherRequester = await withGrantScope(requesterUser2.id, "requester", (tx) => tx.select().from(query).where(eq(query.requestId, requestId)));
    const seenByAccountant = await withGrantScope(accountantUser.id, "accountant", (tx) => tx.select().from(query).where(eq(query.requestId, requestId)));
    expect(seenByOtherRequester).toHaveLength(1);
    expect(seenByAccountant).toHaveLength(1);
  });

  it("a person named across roles can answer even though their own role isn't directed at", { timeout: 300_000 }, async () => {
    const requestId = await raiseTestRequest();
    // The Requester role AND the accountant by name.
    const raised = await raiseQuery(
      approverUser.id,
      requestId,
      { directedAt: ["requester"], directedUserIds: [accountantUser.id], question: "Requester and accountant both please." },
      META,
    );
    expect(raised.ok).toBe(true);
    if (!raised.ok) return;

    // The accountant's role (accountant) is not in directedAt — only their id matches.
    const byName = await answerQuery(accountantUser.id, requestId, raised.queryId, { answer: "Accounts side is fine." }, META);
    expect(byName.ok).toBe(true);

    // A second query: role targeting still works for someone not named at all.
    const second = await raiseQuery(approverUser.id, requestId, { directedAt: ["requester"], directedUserIds: [accountantUser.id], question: "And again." }, META);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const byRole = await answerQuery(requesterUser2.id, requestId, second.queryId, { answer: "Answering as a requester." }, META);
    expect(byRole.ok).toBe(true);
  });

  it("a query named at a person still freezes every transition until it is answered", { timeout: 300_000 }, async () => {
    const requestId = await raiseTestRequest();
    const raised = await raiseQuery(approverUser.id, requestId, { directedAt: [], directedUserIds: [requesterUser.id], question: "Confirm the amount?" }, META);
    expect(raised.ok).toBe(true);
    if (!raised.ok) return;

    const blocked = await approveRequest(approverUser.id, requestId, APPROVE, META);
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.error).toMatch(/open query/i);

    await answerQuery(requesterUser.id, requestId, raised.queryId, { answer: "Confirmed." }, META);
    const unblocked = await approveRequest(approverUser.id, requestId, APPROVE, META);
    expect(unblocked.ok).toBe(true);
  });

  it("refuses named people the server can't vouch for", { timeout: 300_000 }, async () => {
    const requestId = await raiseTestRequest();
    const ask = (directedUserIds: string[], directedAt: ("requester" | "approver")[] = []) =>
      raiseQuery(approverUser.id, requestId, { directedAt, directedUserIds, question: "Anyone?" }, META);

    expect((await ask([approverUserB.id])).ok).toBe(false); // grant is for another department
    expect((await ask([revokedApprover.id])).ok).toBe(false); // grant revoked
    expect((await ask([randomUUID()])).ok).toBe(false); // no such person
    expect((await ask([requesterUser.id, randomUUID()])).ok).toBe(false); // one bad id sinks the lot
    expect((await ask([approverUser.id], ["requester"])).ok).toBe(false); // yourself
    expect((await ask([], [])).ok).toBe(false); // nobody at all

    const rows = await dbOwner.select().from(query).where(eq(query.requestId, requestId));
    expect(rows).toHaveLength(0);
  });

  it("the trail records who was asked, by name", { timeout: 300_000 }, async () => {
    const requestId = await raiseTestRequest();
    const raised = await raiseQuery(approverUser.id, requestId, { directedAt: ["approver"], directedUserIds: [requesterUser.id], question: "Trail check." }, META);
    expect(raised.ok).toBe(true);

    const evs = await dbOwner.select().from(event).where(eq(event.requestId, requestId));
    const raisedEvent = evs.find((e) => e.type === "request.query_raised");
    expect(raisedEvent).toBeDefined();
    const after = raisedEvent!.after as { directedAt: string[]; directedUserIds: string[]; directedUsers: { id: string; name: string }[] };
    expect(after.directedAt).toEqual(["approver"]);
    expect(after.directedUserIds).toEqual([requesterUser.id]);
    expect(after.directedUsers).toEqual([{ id: requesterUser.id, name: `Queries Test requester ${nonce}` }]);
  });

  it("notifications: named people are emailed directly, role targets fan out, and nobody is emailed twice", { timeout: 300_000 }, async () => {
    const requestId = await raiseTestRequest();

    // requesterUser is named AND holds the directed Requester role; requesterUser2
    // is reached by role only; accountantUser by name only.
    const emails = await notifyQueryRaised(approverUser.id, "approver", requestId, ["requester"], "Who owns this?", [requesterUser.id, accountantUser.id]);
    expect(emails.sort()).toEqual([requesterUser.email, requesterUser2.email, accountantUser.email].sort());
    expect(new Set(emails).size).toBe(emails.length);

    // Named only: the other requester is NOT pinged — the point of naming someone.
    const namedOnly = await notifyQueryRaised(approverUser.id, "approver", requestId, [], "Just you.", [requesterUser.id]);
    expect(namedOnly).toEqual([requesterUser.email]);

    // Role only behaves exactly as before.
    const roleOnly = await notifyQueryRaised(approverUser.id, "approver", requestId, ["requester"], "Any requester.");
    expect(roleOnly.sort()).toEqual([requesterUser.email, requesterUser2.email].sort());
  });
});
