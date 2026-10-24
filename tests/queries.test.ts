import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeOwnerConnection, dbOwner } from "../scripts/db-owner";
import { cleanupFixturesForNonce } from "../scripts/fixtures";
import { withGrantScope } from "../src/db/runtime";
import { department, query, request, roleGrant, user } from "../src/db/schema";
import { hashSecret } from "../src/auth/password";
import { answerQuery, raiseQuery } from "../src/conversation/queriesCore";
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

  await grant(requesterUser.id, "requester", { deptIds: [deptA.id] });
  await grant(approverUser.id, "approver", { deptIds: [deptA.id] });
  await grant(approverUserB.id, "approver", { deptIds: [deptB.id] });
});

afterAll(async () => {
  try {
    await cleanupFixturesForNonce(dbOwner, nonce);
  } finally {
    await closeOwnerConnection();
  }
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
