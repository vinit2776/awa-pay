import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeOwnerConnection, dbOwner } from "../scripts/db-owner";
import { cleanupFixturesForNonce } from "../scripts/fixtures";
import { UnauthorizedGrantError, withGrantScope } from "../src/db/runtime";
import { company, department, event, headOfAccount, request, roleGrant, user, vendor, vendorBank } from "../src/db/schema";
import { computeEventHash } from "../src/events/hash";
import { hashSecret } from "../src/auth/password";
import { submitRequest, type Attachment } from "../src/requests/captureCore";
import {
  accountRequest,
  approveRequest,
  holdRequest,
  payRequest,
  rejectRequest,
  releaseHold,
  resubmitRequest,
  returnRequestToRequester,
  returnToAccounts,
  returnToApprover,
} from "../src/requests/transitions";
import { presignPutUrl } from "../src/storage/r2";
import { buildStorageKey } from "../src/storage/storageKey";

// The phase-4 gate. Exercises the real transitions.ts against the real dev
// Supabase project and real R2, not mocks — same philosophy as
// tests/{isolation,auth,capture}.test.ts. Explicitly browser-only, NOT
// attempted here: viewing a presigned-GET bill in an actual viewer, the
// queues' visual sort/tabs, a full click-through approve->account->pay
// walkthrough through real forms, and "someone other than you has put a
// real bill through it" — inherently a human check.

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
  return {
    fileId,
    storageKey,
    mime,
    byteLength: bytes.length,
    // Unique per call, not a fixed placeholder: phase 11's capture-time
    // duplicate check matches on this value org-wide, and a fixed
    // placeholder would make every request in this file (and others)
    // look like a resubmission of the same already-paid bill. Real
    // hashing is still capture.test.ts's job, not this file's.
    sha256: randomUUID().padEnd(64, "0"),
  };
}

let deptA: { id: string };
let deptB: { id: string };
let companyX: { id: string };
let companyY: { id: string };
let head: { id: string };
let testVendor: { id: string };

let requesterUser: { id: string; email: string };
let approverUser: { id: string };
let approverUserB: { id: string }; // deptB — out of scope
let accountantUser: { id: string };
let accountantUserY: { id: string }; // companyY — out of scope
let payerUser: { id: string };
let payerUserY: { id: string }; // companyY — out of scope
let dualRoleUser: { id: string }; // requester + approver, for self-approval

async function grant(userId: string, role: string, opts: { deptIds?: string[]; companyIds?: string[] } = {}) {
  await dbOwner.insert(roleGrant).values({
    userId,
    role: role as (typeof roleGrant.$inferInsert)["role"],
    deptScope: opts.deptIds ? "list" : "global",
    departmentIds: opts.deptIds,
    companyScope: opts.companyIds ? "list" : role === "accountant" || role === "payer" ? "global" : "n/a",
    companyIds: opts.companyIds,
    grantedBy: userId,
  });
}

async function makeUser(label: string): Promise<{ id: string; email: string }> {
  const [u] = await dbOwner
    .insert(user)
    .values({
      name: `Desks Test ${label} ${nonce}`,
      email: `desks-test-${label}-${nonce}@example.invalid`,
      passwordHash: await hashSecret("unused-in-desks-test"),
    })
    .returning({ id: user.id, email: user.email });
  return u;
}

beforeAll(async () => {
  [deptA] = await dbOwner
    .insert(department)
    .values({ name: `Desks Test Dept A ${nonce}`, code: `DSK-A-${nonce}`, ageingThresholdDays: 30 })
    .returning({ id: department.id });
  [deptB] = await dbOwner
    .insert(department)
    .values({ name: `Desks Test Dept B ${nonce}`, code: `DSK-B-${nonce}`, ageingThresholdDays: 30 })
    .returning({ id: department.id });

  [companyX] = await dbOwner
    .insert(company)
    .values({ name: `Desks Test Co X ${nonce}`, legalName: `Desks Test Co X Pvt Ltd ${nonce}` })
    .returning({ id: company.id });
  [companyY] = await dbOwner
    .insert(company)
    .values({ name: `Desks Test Co Y ${nonce}`, legalName: `Desks Test Co Y Pvt Ltd ${nonce}` })
    .returning({ id: company.id });

  [head] = await dbOwner
    .insert(headOfAccount)
    .values({ name: `Desks Test Head ${nonce}`, code: `HEAD-${nonce}` })
    .returning({ id: headOfAccount.id });

  requesterUser = await makeUser("requester");
  approverUser = await makeUser("approver");
  approverUserB = await makeUser("approver-b");
  accountantUser = await makeUser("accountant");
  accountantUserY = await makeUser("accountant-y");
  payerUser = await makeUser("payer");
  payerUserY = await makeUser("payer-y");
  dualRoleUser = await makeUser("dual-role");

  await grant(requesterUser.id, "requester", { deptIds: [deptA.id] });
  await grant(approverUser.id, "approver", { deptIds: [deptA.id] });
  await grant(approverUserB.id, "approver", { deptIds: [deptB.id] });
  await grant(accountantUser.id, "accountant", { companyIds: [companyX.id] });
  await grant(accountantUserY.id, "accountant", { companyIds: [companyY.id] });
  await grant(payerUser.id, "payer", { companyIds: [companyX.id] });
  await grant(payerUserY.id, "payer", { companyIds: [companyY.id] });
  await grant(dualRoleUser.id, "requester", { deptIds: [deptA.id] });
  await grant(dualRoleUser.id, "approver", { deptIds: [deptA.id] });

  [testVendor] = await dbOwner
    .insert(vendor)
    .values({ name: `Desks Test Vendor ${nonce}`, createdBy: accountantUser.id })
    .returning({ id: vendor.id });
  // Pre-verified, inserted directly (not through the app layer, like the
  // rest of this file's fixtures) — phase 10's payer-verification gate
  // (src/vendors/verifyCore.ts) now blocks payRequest on an unverified or
  // absent bank, and this file's own payment tests predate that gate and
  // aren't testing it (tests/payer-verification.test.ts is). Give the
  // shared test vendor a verified bank up front so those tests keep
  // exercising the four desks, not the verification gate.
  await dbOwner.insert(vendorBank).values({
    vendorId: testVendor.id,
    beneficiaryName: `Desks Test Vendor ${nonce}`,
    accountNumberEncrypted: "unused-in-desks-test",
    accountNumberLast4: "0000",
    ifsc: "TEST0000000",
    effectiveFrom: "2026-01-01",
    enteredBy: accountantUser.id,
    enteredAsRole: "accountant",
    verifiedBy: payerUser.id,
    verifiedAt: new Date(),
  });
});

afterAll(async () => {
  try {
    await cleanupFixturesForNonce(dbOwner, nonce);
  } finally {
    await closeOwnerConnection();
  }
});

async function raiseTestRequest(): Promise<string> {
  const file = await uploadTestFile();
  const result = await submitRequest({
    userId: requesterUser.id,
    ip: META.ip,
    userAgent: META.userAgent,
    departmentId: deptA.id,
    amountMinor: 100000,
    attachments: [file],
  });
  if (!result.ok) throw new Error(result.error);
  return result.requestId;
}

describe("the four desks (the phase-4 gate)", () => {
  it("a freshly captured request is awaiting_approval immediately (regression: the stage-0 fix)", async () => {
    const requestId = await raiseTestRequest();
    const [row] = await withGrantScope(requesterUser.id, "requester", (tx) =>
      tx.select({ stage: request.stage }).from(request).where(eq(request.id, requestId)),
    );
    expect(row.stage).toBe("awaiting_approval");
  });

  it(
    "the full happy path: approve -> account -> pay -> paid, with the exact event.type sequence and an intact hash chain",
    async () => {
      const requestId = await raiseTestRequest();

      const approveResult = await approveRequest(
        approverUser.id,
        requestId,
        { cycle: "immediate", dueDate: null, noteToAccountsAndPayer: null },
        META,
      );
      expect(approveResult.ok).toBe(true);

      const accountResult = await accountRequest(
        accountantUser.id,
        requestId,
        { companyId: companyX.id, vendorId: testVendor.id, headId: head.id, voucherNo: `PV-${nonce}-1`, bookedOn: "2026-08-20" },
        META,
      );
      expect(accountResult.ok).toBe(true);

      const payResult = await payRequest(
        payerUser.id,
        requestId,
        {
          fromAccount: { id: "acc-1", label: "Main", bankName: "Test Bank", accountNumber: "000111", ifsc: "TEST0001" },
          mode: "neft",
          valueDate: "2026-08-21",
          amountMinor: 100000,
          tdsMinor: 0,
          reference: `UTR-${nonce}-1`,
        },
        META,
      );
      expect(payResult.ok).toBe(true);

      const [finalRow] = await withGrantScope(payerUser.id, "payer", (tx) =>
        tx.select({ stage: request.stage }).from(request).where(eq(request.id, requestId)),
      );
      expect(finalRow.stage).toBe("paid");

      const events = await withGrantScope(requesterUser.id, "requester", (tx) =>
        tx.select().from(event).where(eq(event.requestId, requestId)).orderBy(event.at),
      );
      expect(events.map((e) => e.type)).toEqual([
        "request.raised",
        "request.approved",
        "request.accounted",
        "request.paid",
      ]);

      // The hash chain's second link (and third, and fourth): each
      // prevHash matches the prior hash, recomputed and verified.
      expect(events[0].prevHash).toBeNull();
      for (let i = 1; i < events.length; i++) {
        expect(events[i].prevHash).toBe(events[i - 1].hash);
        const recomputed = computeEventHash(
          {
            requestId: events[i].requestId,
            actor: events[i].actor,
            roleAtTime: events[i].roleAtTime,
            type: events[i].type,
            objectType: events[i].objectType,
            objectId: events[i].objectId,
            before: events[i].before,
            after: events[i].after,
            reason: events[i].reason,
          },
          events[i].prevHash,
        );
        expect(recomputed).toBe(events[i].hash);
      }
    },
  );

  it(
    "two concurrent approve calls on the same request: exactly one succeeds, the chain doesn't fork",
    async () => {
      const requestId = await raiseTestRequest();

      const results = await Promise.all([
        approveRequest(approverUser.id, requestId, { cycle: "unspecified", dueDate: null, noteToAccountsAndPayer: null }, META),
        approveRequest(approverUser.id, requestId, { cycle: "unspecified", dueDate: null, noteToAccountsAndPayer: null }, META),
      ]);

      const succeeded = results.filter((r) => r.ok);
      expect(succeeded).toHaveLength(1);

      const events = await withGrantScope(approverUser.id, "approver", (tx) =>
        tx.select().from(event).where(eq(event.requestId, requestId)).orderBy(event.at),
      );
      expect(events).toHaveLength(2); // raised + exactly one approved
      expect(events[1].prevHash).toBe(events[0].hash);
    },
  );

  it("an out-of-scope approver cannot act on another department's request (clean not-found, not a leak)", async () => {
    const requestId = await raiseTestRequest();
    const result = await approveRequest(
      approverUserB.id,
      requestId,
      { cycle: "unspecified", dueDate: null, noteToAccountsAndPayer: null },
      META,
    );
    expect(result.ok).toBe(false);
  });

  it(
    "company isolation: an out-of-scope accountant is rejected at write; after legitimate accounting, an out-of-scope payer's queue and pay call are both blocked",
    async () => {
      const requestId = await raiseTestRequest();
      await approveRequest(approverUser.id, requestId, { cycle: "unspecified", dueDate: null, noteToAccountsAndPayer: null }, META);

      // companyX, not companyY: accountantUserY's own scope IS companyY, so
      // that would legitimately succeed. The rejection this proves is that
      // company scope constrains which company an accountant can book
      // into — accountX is out of accountantUserY's scope.
      await expect(
        accountRequest(accountantUserY.id, requestId, { companyId: companyX.id, vendorId: testVendor.id, headId: head.id, voucherNo: "X", bookedOn: "2026-08-20" }, META),
      ).rejects.toThrow();

      const accountResult = await accountRequest(
        accountantUser.id,
        requestId,
        { companyId: companyX.id, vendorId: testVendor.id, headId: head.id, voucherNo: `PV-${nonce}-2`, bookedOn: "2026-08-20" },
        META,
      );
      expect(accountResult.ok).toBe(true);

      const payerYQueue = await withGrantScope(payerUserY.id, "payer", (tx) =>
        tx.select({ id: request.id }).from(request).where(eq(request.id, requestId)),
      );
      expect(payerYQueue).toHaveLength(0);

      const payResult = await payRequest(
        payerUserY.id,
        requestId,
        {
          fromAccount: { id: "acc-y", label: "Y", bankName: "Y Bank", accountNumber: "999", ifsc: "YBNK0001" },
          mode: "neft",
          valueDate: "2026-08-21",
          amountMinor: 100000,
          tdsMinor: 0,
          reference: `UTR-${nonce}-y`,
        },
        META,
      );
      expect(payResult.ok).toBe(false);
    },
  );

  it("return for correction, then resubmit, closes the loop back to awaiting_approval", async () => {
    const requestId = await raiseTestRequest();

    const returnResult = await returnRequestToRequester(approverUser.id, requestId, { reason: "Wrong rate on the bill." }, META);
    expect(returnResult.ok).toBe(true);

    const [returned] = await withGrantScope(requesterUser.id, "requester", (tx) =>
      tx.select({ stage: request.stage, revision: request.revision }).from(request).where(eq(request.id, requestId)),
    );
    expect(returned.stage).toBe("raised");

    const resubmitResult = await resubmitRequest(
      requesterUser.id,
      requestId,
      { amountMinor: 110000, newAttachments: [] },
      META,
    );
    expect(resubmitResult.ok).toBe(true);

    const [resubmitted] = await withGrantScope(requesterUser.id, "requester", (tx) =>
      tx.select({ stage: request.stage, revision: request.revision }).from(request).where(eq(request.id, requestId)),
    );
    expect(resubmitted.stage).toBe("awaiting_approval");
    expect(resubmitted.revision).toBe(returned.revision + 1);
  });

  it("hold, then release, returns to awaiting_approval; hold then reject is terminal", async () => {
    const holdThenReleaseId = await raiseTestRequest();
    const holdResult = await holdRequest(
      approverUser.id,
      holdThenReleaseId,
      { reviewOn: "2026-09-01", subReason: "damaged", reason: "One unit damaged in transit." },
      META,
    );
    expect(holdResult.ok).toBe(true);
    const releaseResult = await releaseHold(approverUser.id, holdThenReleaseId, META);
    expect(releaseResult.ok).toBe(true);
    const [released] = await withGrantScope(approverUser.id, "approver", (tx) =>
      tx.select({ stage: request.stage }).from(request).where(eq(request.id, holdThenReleaseId)),
    );
    expect(released.stage).toBe("awaiting_approval");

    const holdThenRejectId = await raiseTestRequest();
    await holdRequest(approverUser.id, holdThenRejectId, { reviewOn: "2026-09-01", subReason: "rate_dispute", reason: "Rate dispute." }, META);
    const rejectResult = await rejectRequest(approverUser.id, holdThenRejectId, { reason: "Vendor never resolved it." }, META);
    expect(rejectResult.ok).toBe(true);

    // Reopening is not a thing: no further transition succeeds on a terminal request.
    const secondReject = await rejectRequest(approverUser.id, holdThenRejectId, { reason: "again" }, META);
    expect(secondReject.ok).toBe(false);
  });

  it("both return-to-previous-desk paths work: accounts -> approver, payer -> accounts", async () => {
    const requestId = await raiseTestRequest();
    await approveRequest(approverUser.id, requestId, { cycle: "unspecified", dueDate: null, noteToAccountsAndPayer: null }, META);

    const returnToApproverResult = await returnToApprover(accountantUser.id, requestId, { reason: "Missing department code." }, META);
    expect(returnToApproverResult.ok).toBe(true);
    const [afterReturnToApprover] = await withGrantScope(approverUser.id, "approver", (tx) =>
      tx.select({ stage: request.stage }).from(request).where(eq(request.id, requestId)),
    );
    expect(afterReturnToApprover.stage).toBe("awaiting_approval");

    await approveRequest(approverUser.id, requestId, { cycle: "unspecified", dueDate: null, noteToAccountsAndPayer: null }, META);
    await accountRequest(accountantUser.id, requestId, { companyId: companyX.id, vendorId: testVendor.id, headId: head.id, voucherNo: `PV-${nonce}-3`, bookedOn: "2026-08-20" }, META);

    const returnToAccountsResult = await returnToAccounts(payerUser.id, requestId, { reason: "Vendor bank mismatch." }, META);
    expect(returnToAccountsResult.ok).toBe(true);
    const [afterReturnToAccounts] = await withGrantScope(accountantUser.id, "accountant", (tx) =>
      tx.select({ stage: request.stage }).from(request).where(eq(request.id, requestId)),
    );
    expect(afterReturnToAccounts.stage).toBe("with_accounts");
  });

  it("payment.reference must be unique across different requests (AGENTS.md rule 7)", async () => {
    const requestId1 = await raiseTestRequest();
    const requestId2 = await raiseTestRequest();
    const sharedReference = `UTR-DUPLICATE-${nonce}`;

    for (const id of [requestId1, requestId2]) {
      await approveRequest(approverUser.id, id, { cycle: "unspecified", dueDate: null, noteToAccountsAndPayer: null }, META);
      await accountRequest(accountantUser.id, id, { companyId: companyX.id, vendorId: testVendor.id, headId: head.id, voucherNo: `PV-${nonce}-${id}`, bookedOn: "2026-08-20" }, META);
    }

    const fromAccount = { id: "acc-1", label: "Main", bankName: "Test Bank", accountNumber: "000111", ifsc: "TEST0001" };
    const first = await payRequest(payerUser.id, requestId1, { fromAccount, mode: "neft", valueDate: "2026-08-21", amountMinor: 100000, tdsMinor: 0, reference: sharedReference }, META);
    expect(first.ok).toBe(true);

    // Phase 11 turned the raw unique-violation into a graceful, friendly
    // error (src/requests/transitions.ts's own catch around payRequest) —
    // the underlying guarantee this test is actually about,
    // request.payment_reference_unique_idx, is unchanged and still fires;
    // only how payRequest reports it changed. Case-insensitivity itself is
    // tests/duplicate-control.test.ts's own, more specific test.
    const second = await payRequest(payerUser.id, requestId2, { fromAccount, mode: "neft", valueDate: "2026-08-21", amountMinor: 100000, tdsMinor: 0, reference: sharedReference }, META);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toMatch(/already been used/i);
  });

  it("self-approval is allowed and recorded, never blocked", async () => {
    const file = await uploadTestFile();
    const raised = await submitRequest({
      userId: dualRoleUser.id,
      ip: META.ip,
      userAgent: META.userAgent,
      departmentId: deptA.id,
      amountMinor: 50000,
      attachments: [file],
    });
    if (!raised.ok) throw new Error(raised.error);

    const approveResult = await approveRequest(
      dualRoleUser.id,
      raised.requestId,
      { cycle: "unspecified", dueDate: null, noteToAccountsAndPayer: null },
      META,
    );
    expect(approveResult.ok).toBe(true);

    const events = await withGrantScope(dualRoleUser.id, "requester", (tx) =>
      tx.select().from(event).where(eq(event.requestId, raised.requestId)).orderBy(event.at),
    );
    const approvedEvent = events.find((e) => e.type === "request.approved");
    expect((approvedEvent?.after as { selfActioned?: boolean })?.selfActioned).toBe(true);
  });

  it("rejects a transition from a user with no active grant for that role", async () => {
    const requestId = await raiseTestRequest();
    await expect(
      accountRequest(requesterUser.id, requestId, { companyId: companyX.id, vendorId: testVendor.id, headId: head.id, voucherNo: "X", bookedOn: "2026-08-20" }, META),
    ).rejects.toThrow(UnauthorizedGrantError);
  });
});
