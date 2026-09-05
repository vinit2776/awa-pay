import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeOwnerConnection, dbOwner } from "../scripts/db-owner";
import { withGrantScope } from "../src/db/runtime";
import {
  accounting,
  company,
  department,
  duplicateCheck,
  event,
  headOfAccount,
  payment,
  request,
  requestFile,
  roleGrant,
  user,
  vendor,
  vendorBank,
} from "../src/db/schema";
import { hashSecret } from "../src/auth/password";
import { submitRequest } from "../src/requests/captureCore";
import { accountRequest, approveRequest, payRequest, rejectRequest } from "../src/requests/transitions";
import { presignPutUrl } from "../src/storage/r2";
import { buildStorageKey } from "../src/storage/storageKey";
import { createVendor, setVendorBank } from "../src/vendors/vendorsCore";
import { verifyVendorBank, checkPaymentBankReadiness } from "../src/vendors/verifyCore";

// The phase-11 gate. Same philosophy as tests/{vendors,payer-verification}
// .test.ts: exercises the real duplicateCore.ts/captureCore.ts/
// transitions.ts against the real dev Supabase project, no mocks.
// Explicitly browser-only, NOT attempted here: the capture form's and
// AccountantPanel's own comparison cards, the reconsideration banner.

const nonce = randomUUID().slice(0, 8);
const META = { ip: "203.0.113.33", userAgent: "vitest" };

async function uploadTestFile(sha256: string): Promise<{ fileId: string; storageKey: string; mime: string; byteLength: number; sha256: string }> {
  const fileId = randomUUID();
  const mime = "application/pdf";
  const storageKey = buildStorageKey("bills", fileId, mime);
  const uploadUrl = await presignPutUrl(storageKey, mime);
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  const response = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": mime }, body: bytes });
  if (!response.ok) throw new Error(`Test fixture upload failed: ${response.status}`);
  // sha256 is caller-supplied, not recomputed from the (fixed, tiny)
  // upload bytes — duplicateCore matches on the stored value, same as
  // every other test file's placeholder-hash convention; what matters
  // here is two attachments sharing (or not sharing) the same value.
  return { fileId, storageKey, mime, byteLength: bytes.length, sha256 };
}

let deptA: { id: string };
let deptB: { id: string };
let companyX: { id: string };
let head: { id: string };

let requesterA: { id: string };
let approverA: { id: string };
let requesterB: { id: string };
let approverB: { id: string };
let accountantUser: { id: string };
let payerUser: { id: string };
let superAdminRequester: { id: string };

const createdVendorIds: string[] = [];

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

async function makeUser(label: string): Promise<{ id: string }> {
  const [u] = await dbOwner
    .insert(user)
    .values({ name: `Dup Test ${label} ${nonce}`, email: `dup-test-${label}-${nonce}@example.invalid`, passwordHash: await hashSecret("unused") })
    .returning({ id: user.id });
  return u;
}

async function raiseRequest(requesterId: string, deptId: string, sha256: string, opts: { invoiceNo?: string; invoiceDate?: string; linkedRequestId?: string; overrideDuplicateReason?: string } = {}) {
  const file = await uploadTestFile(sha256);
  return submitRequest({
    userId: requesterId,
    ip: META.ip,
    userAgent: META.userAgent,
    departmentId: deptId,
    amountMinor: 75000,
    invoiceNo: opts.invoiceNo,
    invoiceDate: opts.invoiceDate,
    attachments: [file],
    linkedRequestId: opts.linkedRequestId,
    overrideDuplicate: opts.overrideDuplicateReason ? { reason: opts.overrideDuplicateReason } : undefined,
  });
}

async function fullyPayVendorSetup(): Promise<{ id: string }> {
  const requestIdForVendor = (await raiseRequest(requesterA.id, deptA.id, `seed-${randomUUID()}`.padEnd(64, "0"))) as { ok: true; requestId: string };
  const created = await createVendor(accountantUser.id, "accountant", requestIdForVendor.requestId, { name: `Dup Test Vendor ${nonce} ${randomUUID().slice(0, 6)}` }, META);
  if (!created.ok) throw new Error(created.error);
  createdVendorIds.push(created.id);
  const bank = await setVendorBank(accountantUser.id, created.id, {
    beneficiaryName: "Dup Test Vendor",
    accountNumber: "000123123123",
    ifsc: "TEST0009999",
    branch: null,
    effectiveFrom: "2026-01-01",
  });
  if (!bank.ok) throw new Error(bank.error);
  return created;
}

async function raiseApproveAccountPay(vendorId: string, sha256: string, invoiceNo: string, invoiceDate: string, voucherSuffix: string) {
  const raised = (await raiseRequest(requesterA.id, deptA.id, sha256, { invoiceNo, invoiceDate })) as { ok: true; requestId: string; ref: string };
  const approveResult = await approveRequest(approverA.id, raised.requestId, { cycle: "immediate", dueDate: null, noteToAccountsAndPayer: null }, META);
  if (!approveResult.ok) throw new Error(approveResult.error);
  const accountResult = await accountRequest(accountantUser.id, raised.requestId, { companyId: companyX.id, vendorId, headId: head.id, voucherNo: `PV-${nonce}-${voucherSuffix}`, bookedOn: invoiceDate }, META);
  if (!accountResult.ok) throw new Error(accountResult.error);

  const readiness = await checkPaymentBankReadiness(payerUser.id, raised.requestId);
  if (!readiness.ready && readiness.reason === "unverified") {
    const verify = await verifyVendorBank(payerUser.id, raised.requestId, readiness.bank.id, META);
    if (!verify.ok) throw new Error(verify.error);
  }

  const payResult = await payRequest(
    payerUser.id,
    raised.requestId,
    { fromAccount: { id: "acc-1", label: "Main", bankName: "Test Bank", accountNumber: "000111", ifsc: "TEST0001" }, mode: "neft", valueDate: invoiceDate, amountMinor: 75000, tdsMinor: 0, reference: `UTR-${nonce}-${voucherSuffix}` },
    META,
  );
  if (!payResult.ok) throw new Error(payResult.error);

  return raised.requestId;
}

beforeAll(async () => {
  [deptA] = await dbOwner.insert(department).values({ name: `Dup Test Dept A ${nonce}`, code: `DUP-A-${nonce}`, ageingThresholdDays: 30 }).returning({ id: department.id });
  [deptB] = await dbOwner.insert(department).values({ name: `Dup Test Dept B ${nonce}`, code: `DUP-B-${nonce}`, ageingThresholdDays: 30 }).returning({ id: department.id });
  [companyX] = await dbOwner.insert(company).values({ name: `Dup Test Co X ${nonce}`, legalName: `Dup Test Co X ${nonce} Pvt Ltd` }).returning({ id: company.id });
  [head] = await dbOwner.insert(headOfAccount).values({ name: `Dup Test Head ${nonce}`, code: `DUP-H-${nonce}` }).returning({ id: headOfAccount.id });

  requesterA = await makeUser("requester-a");
  approverA = await makeUser("approver-a");
  requesterB = await makeUser("requester-b");
  approverB = await makeUser("approver-b");
  accountantUser = await makeUser("accountant");
  payerUser = await makeUser("payer");
  superAdminRequester = await makeUser("super-admin-requester");

  await grant(requesterA.id, "requester", { deptIds: [deptA.id] });
  await grant(approverA.id, "approver", { deptIds: [deptA.id] });
  await grant(requesterB.id, "requester", { deptIds: [deptB.id] });
  await grant(approverB.id, "approver", { deptIds: [deptB.id] });
  await grant(accountantUser.id, "accountant", { companyIds: [companyX.id] });
  // Also super_admin, so the account-time override test can exercise a
  // real "two roles, two rows" actor per role_grant's own model — the
  // ordinary account-time tests are unaffected since holding an extra
  // role never narrows what the existing accountant grant already does.
  await grant(accountantUser.id, "super_admin");
  await grant(payerUser.id, "payer", { companyIds: [companyX.id] });
  await grant(superAdminRequester.id, "requester", { deptIds: [deptA.id] });
  await grant(superAdminRequester.id, "super_admin");
}, 60_000);

afterAll(async () => {
  const userIds = [requesterA.id, approverA.id, requesterB.id, approverB.id, accountantUser.id, payerUser.id, superAdminRequester.id];

  const reqs = await dbOwner.select({ id: request.id }).from(request).where(inArray(request.departmentId, [deptA.id, deptB.id]));
  const reqIds = reqs.map((r) => r.id);
  if (reqIds.length > 0) {
    await dbOwner.delete(duplicateCheck).where(inArray(duplicateCheck.requestId, reqIds));
    await dbOwner.delete(payment).where(inArray(payment.requestId, reqIds));
    await dbOwner.delete(accounting).where(inArray(accounting.requestId, reqIds));
    await dbOwner.delete(event).where(inArray(event.requestId, reqIds));
    await dbOwner.delete(requestFile).where(inArray(requestFile.requestId, reqIds));
    await dbOwner.delete(request).where(inArray(request.id, reqIds));
  }
  await dbOwner.delete(roleGrant).where(inArray(roleGrant.userId, userIds));
  if (createdVendorIds.length > 0) {
    await dbOwner.delete(vendorBank).where(inArray(vendorBank.vendorId, createdVendorIds));
    await dbOwner.delete(vendor).where(inArray(vendor.id, createdVendorIds));
  }
  await dbOwner.delete(headOfAccount).where(eq(headOfAccount.id, head.id));
  await dbOwner.delete(department).where(inArray(department.id, [deptA.id, deptB.id]));
  await dbOwner.delete(company).where(eq(company.id, companyX.id));
  await dbOwner.delete(user).where(inArray(user.id, userIds));
  await closeOwnerConnection();
}, 60_000);

describe("duplicate control (the phase-11 gate)", () => {
  it("a byte-identical file at capture time is hard-blocked against an already-paid request, and a non-super_admin can't override it", async () => {
    const vendorForTest = await fullyPayVendorSetup();
    const sha = `capture-${randomUUID()}`.padEnd(64, "0");
    await raiseApproveAccountPay(vendorForTest.id, sha, `INV-${nonce}-CAP`, "2026-02-10", "cap1");

    const blocked = await raiseRequest(requesterA.id, deptA.id, sha);
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.duplicate?.verdict).toBe("blocked_paid");

    const stillBlocked = await raiseRequest(requesterA.id, deptA.id, sha, { overrideDuplicateReason: "I promise it's fine" });
    expect(stillBlocked.ok).toBe(false);
    if (stillBlocked.ok) return;
    expect(stillBlocked.error).toMatch(/super admin/i);
  });

  it("a super_admin-holding requester can override the capture-time block, and the override is recorded", async () => {
    const vendorForTest = await fullyPayVendorSetup();
    const sha = `capture-override-${randomUUID()}`.padEnd(64, "0");
    await raiseApproveAccountPay(vendorForTest.id, sha, `INV-${nonce}-OVR`, "2026-02-11", "ovr1");

    const overridden = await raiseRequest(superAdminRequester.id, deptA.id, sha, { overrideDuplicateReason: "Verified with vendor — not a duplicate" });
    expect(overridden.ok).toBe(true);
    if (!overridden.ok) return;

    const [row] = await dbOwner.select().from(duplicateCheck).where(eq(duplicateCheck.requestId, overridden.requestId));
    expect(row.verdict).toBe("blocked_paid");
    expect(row.overriddenBy).toBe(superAdminRequester.id);
  });

  it("accountRequest blocks a vendor+invoice+FY match against an already-paid request, even from a different capture", async () => {
    const vendorForTest = await fullyPayVendorSetup();
    const invoiceNo = `INV-${nonce}-ACCT`;
    const invoiceDate = "2026-03-15";
    await raiseApproveAccountPay(vendorForTest.id, `acct-seed-${randomUUID()}`.padEnd(64, "0"), invoiceNo, invoiceDate, "acct1");

    const raised = (await raiseRequest(requesterA.id, deptA.id, `acct-second-${randomUUID()}`.padEnd(64, "0"), { invoiceNo, invoiceDate })) as { ok: true; requestId: string };
    expect(raised.ok).toBe(true);
    const approveResult = await approveRequest(approverA.id, raised.requestId, { cycle: "immediate", dueDate: null, noteToAccountsAndPayer: null }, META);
    expect(approveResult.ok).toBe(true);

    const blocked = await accountRequest(accountantUser.id, raised.requestId, { companyId: companyX.id, vendorId: vendorForTest.id, headId: head.id, voucherNo: `PV-${nonce}-acct2`, bookedOn: invoiceDate }, META);
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.duplicate?.verdict).toBe("blocked_paid");
  });

  it("request.one_payment_per_invoice still blocks the actual payment even after an application-level override at account time — the override is a review gate, not a backdoor", async () => {
    // Two full raise->approve->account->verify->pay cycles plus a vendor
    // setup, ~12+ sequential round trips — comfortably under the global
    // 60s ceiling locally but timed out on CI at exactly that ceiling on a
    // slower-than-usual run. A per-test override here rather than another
    // global bump, matching vitest.config.mts's own reasoning for not
    // inflating every other, much lighter test's timeout for one heavy
    // outlier.
    const vendorForTest = await fullyPayVendorSetup();
    const invoiceNo = `INV-${nonce}-DB`;
    const invoiceDate = "2026-04-01";
    await raiseApproveAccountPay(vendorForTest.id, `db-seed-${randomUUID()}`.padEnd(64, "0"), invoiceNo, invoiceDate, "db1");

    const raised = (await raiseRequest(superAdminRequester.id, deptA.id, `db-second-${randomUUID()}`.padEnd(64, "0"), { invoiceNo, invoiceDate })) as { ok: true; requestId: string };
    expect(raised.ok).toBe(true);
    const approveResult = await approveRequest(approverA.id, raised.requestId, { cycle: "immediate", dueDate: null, noteToAccountsAndPayer: null }, META);
    expect(approveResult.ok).toBe(true);

    const accountResult = await accountRequest(
      accountantUser.id,
      raised.requestId,
      { companyId: companyX.id, vendorId: vendorForTest.id, headId: head.id, voucherNo: `PV-${nonce}-db2`, bookedOn: invoiceDate, overrideDuplicate: { reason: "Confirmed genuine second bill" } },
      META,
    );
    expect(accountResult.ok).toBe(true);

    const readiness = await checkPaymentBankReadiness(payerUser.id, raised.requestId);
    expect(readiness.ready).toBe(true);

    const payResult = await payRequest(
      payerUser.id,
      raised.requestId,
      { fromAccount: { id: "acc-1", label: "Main", bankName: "Test Bank", accountNumber: "000111", ifsc: "TEST0001" }, mode: "neft", valueDate: invoiceDate, amountMinor: 75000, tdsMinor: 0, reference: `UTR-${nonce}-db2` },
      META,
    );
    expect(payResult.ok).toBe(false);
    if (payResult.ok) return;
    expect(payResult.error).toMatch(/already paid/i);

    const [stillOpen] = await dbOwner.select({ stage: request.stage }).from(request).where(eq(request.id, raised.requestId));
    expect(stillOpen.stage).toBe("to_pay");
  }, 120_000);

  // Same reasoning as the test above — three full raise->approve->account
  // ->verify->pay cycles is the heaviest single test in this file.
  it("payment.reference is unique case-insensitively — the same UTR retyped in a different case is rejected", async () => {
    const vendorForTest = await fullyPayVendorSetup();
    const ref = `UTR-CASE-${nonce}`;
    // Two independent requests, accounted to any verified vendor — the
    // uniqueness is on payment.reference alone, unrelated to vendor or
    // invoice.
    const raised = (await raiseRequest(requesterA.id, deptA.id, `case-second-${randomUUID()}`.padEnd(64, "0"), { invoiceNo: `INV-${nonce}-CASE2`, invoiceDate: "2026-05-02" })) as { ok: true; requestId: string };
    const approveResult = await approveRequest(approverA.id, raised.requestId, { cycle: "immediate", dueDate: null, noteToAccountsAndPayer: null }, META);
    expect(approveResult.ok).toBe(true);
    const accountResult = await accountRequest(accountantUser.id, raised.requestId, { companyId: companyX.id, vendorId: vendorForTest.id, headId: head.id, voucherNo: `PV-${nonce}-case2`, bookedOn: "2026-05-02" }, META);
    expect(accountResult.ok).toBe(true);

    const readiness = await checkPaymentBankReadiness(payerUser.id, raised.requestId);
    if (!readiness.ready && readiness.reason === "unverified") {
      const verify = await verifyVendorBank(payerUser.id, raised.requestId, readiness.bank.id, META);
      expect(verify.ok).toBe(true);
    }

    const firstPay = await payRequest(
      payerUser.id,
      raised.requestId,
      { fromAccount: { id: "acc-1", label: "Main", bankName: "Test Bank", accountNumber: "000111", ifsc: "TEST0001" }, mode: "neft", valueDate: "2026-05-02", amountMinor: 75000, tdsMinor: 0, reference: ref.toLowerCase() },
      META,
    );
    expect(firstPay.ok).toBe(true);

    // A third request, paid with the SAME reference but upper-cased — must fail.
    const raised2 = (await raiseRequest(requesterA.id, deptA.id, `case-third-${randomUUID()}`.padEnd(64, "0"), { invoiceNo: `INV-${nonce}-CASE3`, invoiceDate: "2026-05-03" })) as { ok: true; requestId: string };
    const approveResult2 = await approveRequest(approverA.id, raised2.requestId, { cycle: "immediate", dueDate: null, noteToAccountsAndPayer: null }, META);
    expect(approveResult2.ok).toBe(true);
    const accountResult2 = await accountRequest(accountantUser.id, raised2.requestId, { companyId: companyX.id, vendorId: vendorForTest.id, headId: head.id, voucherNo: `PV-${nonce}-case3`, bookedOn: "2026-05-03" }, META);
    expect(accountResult2.ok).toBe(true);

    const secondPay = await payRequest(
      payerUser.id,
      raised2.requestId,
      { fromAccount: { id: "acc-1", label: "Main", bankName: "Test Bank", accountNumber: "000111", ifsc: "TEST0001" }, mode: "neft", valueDate: "2026-05-03", amountMinor: 75000, tdsMinor: 0, reference: ref.toUpperCase() },
      META,
    );
    expect(secondPay.ok).toBe(false);
    if (secondPay.ok) return;
    expect(secondPay.error).toMatch(/already been used/i);
  }, 120_000);

  it("a reconsidered request resolves routedApproverId from the original's own rejection event", async () => {
    // submitRequest lands a fresh request straight in 'awaiting_approval'
    // (no separate "submit for approval" step) — reject fires from there
    // directly, no approveRequest call needed first.
    const raised = (await raiseRequest(requesterA.id, deptA.id, `reject-seed-${randomUUID()}`.padEnd(64, "0"), { invoiceNo: `INV-${nonce}-REJ`, invoiceDate: "2026-06-01" })) as { ok: true; requestId: string };
    const rejectResult = await rejectRequest(approverA.id, raised.requestId, { reason: "Not a valid claim" }, META);
    expect(rejectResult.ok).toBe(true);

    const reconsidered = (await raiseRequest(requesterA.id, deptA.id, `reconsider-${randomUUID()}`.padEnd(64, "0"), {
      invoiceNo: `INV-${nonce}-RECON`,
      invoiceDate: "2026-06-05",
      linkedRequestId: raised.requestId,
    })) as { ok: true; requestId: string };
    expect(reconsidered.ok).toBe(true);

    const [row] = await withGrantScope(requesterA.id, "requester", (tx) => tx.select({ routedApproverId: request.routedApproverId, linkedRequest: request.linkedRequest }).from(request).where(eq(request.id, reconsidered.requestId)));
    expect(row.routedApproverId).toBe(approverA.id);
    expect(row.linkedRequest).toBe(raised.requestId);
  });

  it("a cross-department match is redacted for an out-of-scope actor: verdict still fires, but reference/date are hidden", async () => {
    const vendorForTest = await fullyPayVendorSetup();
    const sha = `cross-dept-${randomUUID()}`.padEnd(64, "0");
    await raiseApproveAccountPay(vendorForTest.id, sha, `INV-${nonce}-XDEPT`, "2026-07-01", "xdept1");

    // requesterB has no scope over deptA — the paid original lives there.
    const blocked = await raiseRequest(requesterB.id, deptB.id, sha);
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.duplicate?.verdict).toBe("blocked_paid");
    expect(blocked.duplicate?.match.viewableByActor).toBe(false);
    expect(blocked.duplicate?.match.reference).toBeNull();
  });
});
