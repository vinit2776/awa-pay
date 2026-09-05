import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeOwnerConnection, dbOwner } from "../scripts/db-owner";
import { withGrantScope } from "../src/db/runtime";
import { accounting, company, department, event, headOfAccount, payment, request, requestFile, roleGrant, user, vendor, vendorBank, vendorDocument } from "../src/db/schema";
import { hashSecret } from "../src/auth/password";
import { submitRequest, type Attachment } from "../src/requests/captureCore";
import { accountRequest, approveRequest, payRequest } from "../src/requests/transitions";
import { presignPutUrl } from "../src/storage/r2";
import { buildStorageKey } from "../src/storage/storageKey";
import { checkPaymentBankReadiness, insertVendorBankAsPayer, verifyVendorBank } from "../src/vendors/verifyCore";
import { createVendor, setVendorBank } from "../src/vendors/vendorsCore";

// The phase-10 gate. Same philosophy as tests/vendors.test.ts: exercises
// the real verifyCore.ts/transitions.ts against the real dev Supabase
// project, no mocks. Explicitly browser-only, NOT attempted here: the
// verify-first comparison card, the payer's self-correction form.

const nonce = randomUUID().slice(0, 8);
const META = { ip: "203.0.113.32", userAgent: "vitest" };

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
let companyX: { id: string };
let head: { id: string };

let requesterUser: { id: string };
let approverUser: { id: string };
let accountantUser: { id: string };
let payerUser: { id: string };

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
    .values({ name: `Payer Verify Test ${label} ${nonce}`, email: `payer-verify-test-${label}-${nonce}@example.invalid`, passwordHash: await hashSecret("unused") })
    .returning({ id: user.id });
  return u;
}

async function raiseApproveAccount(vendorId: string, voucherSuffix: string): Promise<string> {
  const requestId = await raiseTestRequestOnly();

  const approveResult = await approveRequest(approverUser.id, requestId, { cycle: "immediate", dueDate: null, noteToAccountsAndPayer: null }, META);
  if (!approveResult.ok) throw new Error(approveResult.error);

  const accountResult = await accountRequest(
    accountantUser.id,
    requestId,
    { companyId: companyX.id, vendorId, headId: head.id, voucherNo: `PV-${nonce}-${voucherSuffix}`, bookedOn: "2026-08-20" },
    META,
  );
  if (!accountResult.ok) throw new Error(accountResult.error);

  return requestId;
}

beforeAll(async () => {
  [deptA] = await dbOwner.insert(department).values({ name: `Payer Verify Test Dept A ${nonce}`, code: `PVT-A-${nonce}`, ageingThresholdDays: 30 }).returning({ id: department.id });
  [companyX] = await dbOwner.insert(company).values({ name: `Payer Verify Test Co X ${nonce}`, legalName: `Payer Verify Test Co X ${nonce} Pvt Ltd` }).returning({ id: company.id });
  [head] = await dbOwner.insert(headOfAccount).values({ name: `Payer Verify Test Head ${nonce}`, code: `PVT-H-${nonce}` }).returning({ id: headOfAccount.id });

  requesterUser = await makeUser("requester");
  approverUser = await makeUser("approver");
  accountantUser = await makeUser("accountant");
  payerUser = await makeUser("payer");

  await grant(requesterUser.id, "requester", { deptIds: [deptA.id] });
  await grant(approverUser.id, "approver", { deptIds: [deptA.id] });
  await grant(accountantUser.id, "accountant", { companyIds: [companyX.id] });
  await grant(payerUser.id, "payer", { companyIds: [companyX.id] });
}, 30_000);

afterAll(async () => {
  const userIds = [requesterUser.id, approverUser.id, accountantUser.id, payerUser.id];

  const reqs = await dbOwner.select({ id: request.id }).from(request).where(eq(request.departmentId, deptA.id));
  const reqIds = reqs.map((r) => r.id);
  if (reqIds.length > 0) {
    await dbOwner.delete(payment).where(inArray(payment.requestId, reqIds));
    await dbOwner.delete(accounting).where(inArray(accounting.requestId, reqIds));
    await dbOwner.delete(event).where(inArray(event.requestId, reqIds));
    await dbOwner.delete(requestFile).where(inArray(requestFile.requestId, reqIds));
    await dbOwner.delete(request).where(inArray(request.id, reqIds));
  }
  await dbOwner.delete(roleGrant).where(inArray(roleGrant.userId, userIds));
  if (createdVendorIds.length > 0) {
    await dbOwner.delete(vendorDocument).where(inArray(vendorDocument.vendorId, createdVendorIds));
    await dbOwner.delete(vendorBank).where(inArray(vendorBank.vendorId, createdVendorIds));
    await dbOwner.delete(vendor).where(inArray(vendor.id, createdVendorIds));
  }
  await dbOwner.delete(headOfAccount).where(eq(headOfAccount.id, head.id));
  await dbOwner.delete(department).where(eq(department.id, deptA.id));
  await dbOwner.delete(company).where(eq(company.id, companyX.id));
  await dbOwner.delete(user).where(inArray(user.id, userIds));
  await closeOwnerConnection();
}, 30_000);

describe("payer verification (the phase-10 gate)", () => {
  it("payRequest blocks when the vendor has no bank on file", async () => {
    const requestIdForVendor = await raiseTestRequestOnly();
    const created = await createVendor(accountantUser.id, "accountant", requestIdForVendor, { name: `Payer Verify No Bank ${nonce}` }, META);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    createdVendorIds.push(created.id);

    const requestId = await raiseApproveAccount(created.id, "nobank");

    const result = await payRequest(
      payerUser.id,
      requestId,
      { fromAccount: { id: "acc-1", label: "Main", bankName: "Test Bank", accountNumber: "000111", ifsc: "TEST0001" }, mode: "neft", valueDate: "2026-08-21", amountMinor: 50000, tdsMinor: 0, reference: `UTR-${nonce}-nobank` },
      META,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/no bank details/i);
  });

  it("payRequest blocks when the vendor's current bank is unverified, and verifying unblocks payment in the same session", async () => {
    const requestIdForVendor = await raiseTestRequestOnly();
    const created = await createVendor(accountantUser.id, "accountant", requestIdForVendor, { name: `Payer Verify Unverified ${nonce}` }, META);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    createdVendorIds.push(created.id);

    const bankResult = await setVendorBank(accountantUser.id, created.id, {
      beneficiaryName: `Payer Verify Unverified ${nonce}`,
      accountNumber: "000222333444",
      ifsc: "HDFC0001111",
      branch: null,
      effectiveFrom: "2026-08-20",
    });
    expect(bankResult.ok).toBe(true);

    const requestId = await raiseApproveAccount(created.id, "unverified");

    const blocked = await payRequest(
      payerUser.id,
      requestId,
      { fromAccount: { id: "acc-1", label: "Main", bankName: "Test Bank", accountNumber: "000111", ifsc: "TEST0001" }, mode: "neft", valueDate: "2026-08-21", amountMinor: 50000, tdsMinor: 0, reference: `UTR-${nonce}-unv1` },
      META,
    );
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.error).toMatch(/haven.t been verified/i);

    const readiness = await checkPaymentBankReadiness(payerUser.id, requestId);
    expect(readiness.ready).toBe(false);
    if (readiness.ready) return;
    if (readiness.reason !== "unverified") throw new Error(`expected unverified, got ${readiness.reason}`);

    const verifyResult = await verifyVendorBank(payerUser.id, requestId, readiness.bank.id, META);
    expect(verifyResult.ok).toBe(true);

    const paid = await payRequest(
      payerUser.id,
      requestId,
      { fromAccount: { id: "acc-1", label: "Main", bankName: "Test Bank", accountNumber: "000111", ifsc: "TEST0001" }, mode: "neft", valueDate: "2026-08-21", amountMinor: 50000, tdsMinor: 0, reference: `UTR-${nonce}-unv2` },
      META,
    );
    expect(paid.ok).toBe(true);
  });

  it("a second, separate open request for the same vendor independently re-requires verification after a bank change", async () => {
    const requestIdForVendor = await raiseTestRequestOnly();
    const created = await createVendor(accountantUser.id, "accountant", requestIdForVendor, { name: `Payer Verify Reflag ${nonce}` }, META);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    createdVendorIds.push(created.id);

    await setVendorBank(accountantUser.id, created.id, {
      beneficiaryName: `Payer Verify Reflag ${nonce}`,
      accountNumber: "000555666777",
      ifsc: "ICIC0002222",
      branch: null,
      effectiveFrom: "2026-08-20",
    });

    const requestOneId = await raiseApproveAccount(created.id, "reflag1");
    const readinessOne = await checkPaymentBankReadiness(payerUser.id, requestOneId);
    if (readinessOne.ready) throw new Error("expected unverified");
    if (readinessOne.reason !== "unverified") throw new Error(`expected unverified, got ${readinessOne.reason}`);
    const verifyOne = await verifyVendorBank(payerUser.id, requestOneId, readinessOne.bank.id, META);
    expect(verifyOne.ok).toBe(true);

    // A second request accounted to the SAME vendor, opened AFTER
    // verification, pays straight through — no separate flag was ever set.
    const requestTwoId = await raiseApproveAccount(created.id, "reflag2");
    const readinessTwoBefore = await checkPaymentBankReadiness(payerUser.id, requestTwoId);
    expect(readinessTwoBefore.ready).toBe(true);

    // The accountant supersedes the bank record — the very next readiness
    // check on this SAME, already-open second request flips back to
    // unverified, with zero changes made to request_two itself.
    await setVendorBank(accountantUser.id, created.id, {
      beneficiaryName: `Payer Verify Reflag Changed ${nonce}`,
      accountNumber: "000888999000",
      ifsc: "SBIN0003333",
      branch: null,
      effectiveFrom: "2026-08-21",
    });

    const readinessTwoAfter = await checkPaymentBankReadiness(payerUser.id, requestTwoId);
    expect(readinessTwoAfter.ready).toBe(false);
    if (readinessTwoAfter.ready) return;
    expect(readinessTwoAfter.reason).toBe("unverified");

    const blockedAgain = await payRequest(
      payerUser.id,
      requestTwoId,
      { fromAccount: { id: "acc-1", label: "Main", bankName: "Test Bank", accountNumber: "000111", ifsc: "TEST0001" }, mode: "neft", valueDate: "2026-08-22", amountMinor: 50000, tdsMinor: 0, reference: `UTR-${nonce}-reflag` },
      META,
    );
    expect(blockedAgain.ok).toBe(false);
  });

  it("verifyVendorBank is one-directional: verifying an already-verified row is a safe no-op error, not a re-verify", async () => {
    const requestIdForVendor = await raiseTestRequestOnly();
    const created = await createVendor(accountantUser.id, "accountant", requestIdForVendor, { name: `Payer Verify Double ${nonce}` }, META);
    if (!created.ok) throw new Error(created.error);
    createdVendorIds.push(created.id);

    await setVendorBank(accountantUser.id, created.id, {
      beneficiaryName: `Payer Verify Double ${nonce}`,
      accountNumber: "000111222333",
      ifsc: "AXIS0004444",
      branch: null,
      effectiveFrom: "2026-08-20",
    });

    const requestId = await raiseApproveAccount(created.id, "double");
    const readiness = await checkPaymentBankReadiness(payerUser.id, requestId);
    if (readiness.ready || readiness.reason !== "unverified") throw new Error("expected unverified");

    const first = await verifyVendorBank(payerUser.id, requestId, readiness.bank.id, META);
    expect(first.ok).toBe(true);

    const second = await verifyVendorBank(payerUser.id, requestId, readiness.bank.id, META);
    expect(second.ok).toBe(false);
  });

  it("an accountant cannot verify a vendor_bank row under RLS (only a payer can)", async () => {
    const requestIdForVendor = await raiseTestRequestOnly();
    const created = await createVendor(accountantUser.id, "accountant", requestIdForVendor, { name: `Payer Verify RoleCheck ${nonce}` }, META);
    if (!created.ok) throw new Error(created.error);
    createdVendorIds.push(created.id);

    await setVendorBank(accountantUser.id, created.id, {
      beneficiaryName: `Payer Verify RoleCheck ${nonce}`,
      accountNumber: "000444555666",
      ifsc: "KKBK0005555",
      branch: null,
      effectiveFrom: "2026-08-20",
    });

    const [bank] = await withGrantScope(accountantUser.id, "accountant", (tx) =>
      tx.select().from(vendorBank).where(and(eq(vendorBank.vendorId, created.id), isNull(vendorBank.supersededAt))),
    );

    // Unlike a USING-only mismatch (which silently excludes the row and
    // affects zero rows), this fails WITH CHECK on every policy that could
    // apply — the row satisfies vendor_bank_update_supersede's USING
    // clause (accountant, not yet superseded), but this UPDATE doesn't set
    // superseded_at, so its own WITH CHECK fails; vendor_bank_update_verify
    // never matches at all since the actor's role isn't payer. Postgres
    // raises a hard error for a WITH CHECK violation, not a quiet
    // zero-rows result.
    let caught: unknown;
    try {
      await withGrantScope(accountantUser.id, "accountant", (tx) =>
        tx.update(vendorBank).set({ verifiedBy: accountantUser.id, verifiedAt: new Date() }).where(eq(vendorBank.id, bank.id)).returning({ id: vendorBank.id }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const cause = caught && typeof caught === "object" && "cause" in caught ? (caught as { cause?: { message?: string } }).cause : undefined;
    expect(cause?.message ?? "").toMatch(/row-level security policy/i);
  });

  it("the payer's self-verified correction path requires a vendor_document on file, then inserts a new, immediately verified row", async () => {
    const requestIdForVendor = await raiseTestRequestOnly();
    const created = await createVendor(accountantUser.id, "accountant", requestIdForVendor, { name: `Payer Verify Correction ${nonce}` }, META);
    if (!created.ok) throw new Error(created.error);
    createdVendorIds.push(created.id);

    const withoutDoc = await insertVendorBankAsPayer(payerUser.id, created.id, {
      beneficiaryName: `Payer Verify Correction ${nonce}`,
      accountNumber: "000777888999",
      ifsc: "PUNB0006666",
      branch: null,
      effectiveFrom: "2026-08-20",
    });
    expect(withoutDoc.ok).toBe(false);
    if (!withoutDoc.ok) expect(withoutDoc.error).toMatch(/no documents on file/i);

    await dbOwner.insert(vendorDocument).values({
      vendorId: created.id,
      kind: "cancelled_cheque",
      storageKey: `vendor-documents/${randomUUID()}.pdf`,
      mime: "application/pdf",
      bytes: 4,
      sha256: "0".repeat(64),
      uploadedBy: accountantUser.id,
    });

    const withDoc = await insertVendorBankAsPayer(payerUser.id, created.id, {
      beneficiaryName: `Payer Verify Correction ${nonce}`,
      accountNumber: "000777888999",
      ifsc: "PUNB0006666",
      branch: null,
      effectiveFrom: "2026-08-20",
    });
    expect(withDoc.ok).toBe(true);

    const requestId = await raiseApproveAccount(created.id, "correction");
    const readiness = await checkPaymentBankReadiness(payerUser.id, requestId);
    expect(readiness.ready).toBe(true);
  });

  it("two concurrent payer corrections on the same vendor race safely: exactly one current row survives", async () => {
    const requestIdForVendor = await raiseTestRequestOnly();
    const created = await createVendor(accountantUser.id, "accountant", requestIdForVendor, { name: `Payer Verify Race ${nonce}` }, META);
    if (!created.ok) throw new Error(created.error);
    createdVendorIds.push(created.id);

    await dbOwner.insert(vendorDocument).values({
      vendorId: created.id,
      kind: "cancelled_cheque",
      storageKey: `vendor-documents/${randomUUID()}.pdf`,
      mime: "application/pdf",
      bytes: 4,
      sha256: "0".repeat(64),
      uploadedBy: accountantUser.id,
    });

    const [resultA, resultB] = await Promise.all([
      insertVendorBankAsPayer(payerUser.id, created.id, { beneficiaryName: "Race A", accountNumber: "000111222001", ifsc: "TEST0001", branch: null, effectiveFrom: "2026-08-20" }),
      insertVendorBankAsPayer(payerUser.id, created.id, { beneficiaryName: "Race B", accountNumber: "000111222002", ifsc: "TEST0002", branch: null, effectiveFrom: "2026-08-20" }),
    ]);
    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);

    const current = await dbOwner.select().from(vendorBank).where(and(eq(vendorBank.vendorId, created.id), isNull(vendorBank.supersededAt)));
    expect(current).toHaveLength(1);
  });
});

async function raiseTestRequestOnly(): Promise<string> {
  const file = await uploadTestFile();
  const result = await submitRequest({
    userId: requesterUser.id,
    ip: META.ip,
    userAgent: META.userAgent,
    departmentId: deptA.id,
    amountMinor: 50000,
    attachments: [file],
  });
  if (!result.ok) throw new Error(result.error);
  return result.requestId;
}
