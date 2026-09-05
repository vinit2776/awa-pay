import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeOwnerConnection, dbOwner } from "../scripts/db-owner";
import { hashSecret } from "../src/auth/password";
import { answerQuery, raiseQuery } from "../src/conversation/queriesCore";
import { type Role, withGrantScope } from "../src/db/runtime";
import { accounting, company, department, event, payment, headOfAccount, query, request, requestFile, roleGrant, user, vendor, vendorBank } from "../src/db/schema";
import { computeFlags, loadFlagContext, type Flag, type FlagContext, type RequestForFlags } from "../src/flags/computeFlags";
import { type Attachment, submitRequest } from "../src/requests/captureCore";
import { accountRequest, approveRequest, holdRequest, payRequest } from "../src/requests/transitions";
import { presignPutUrl } from "../src/storage/r2";
import { buildStorageKey } from "../src/storage/storageKey";
import { createVendor, setVendorBank } from "../src/vendors/vendorsCore";
import { checkPaymentBankReadiness, verifyVendorBank } from "../src/vendors/verifyCore";

// The phase-12 gate. Two layers, matching the module's own split: pure
// unit tests against computeFlags directly (no DB, fast, exhaustive on
// boundaries), then integration tests against the real dev Supabase
// project proving loadFlagContext's batched queries actually find what
// they're supposed to — same philosophy as every other slice-3 test file.

const nonce = randomUUID().slice(0, 8);
const META = { ip: "203.0.113.40", userAgent: "vitest" };
const DAY_MS = 24 * 60 * 60 * 1000;

function isoDate(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * DAY_MS).toISOString().slice(0, 10);
}

function baseRow(overrides: Partial<RequestForFlags>): RequestForFlags {
  return {
    id: randomUUID(),
    stage: "awaiting_approval",
    departmentId: "dept-1",
    createdAt: new Date(),
    dueDate: null,
    vendorKey: null,
    amountMinor: 10000,
    invoiceDate: null,
    ...overrides,
  };
}

function emptyContext(overrides: Partial<FlagContext> = {}): FlagContext {
  return {
    now: new Date(),
    ageingThresholdByDept: new Map(),
    openQueryRequestIds: new Set(),
    repeatAmountRequestIds: new Set(),
    bankChangedRequestIds: new Set(),
    ...overrides,
  };
}

describe("computeFlags (pure, the phase-12 gate)", () => {
  it("ageing fires once past the department's threshold, not on or before it", () => {
    const now = new Date("2026-09-05T00:00:00.000Z");
    const ctx = emptyContext({ now, ageingThresholdByDept: new Map([["dept-1", 5]]) });

    const exactlyAtThreshold = baseRow({ createdAt: new Date(now.getTime() - 5 * DAY_MS) });
    const pastThreshold = baseRow({ createdAt: new Date(now.getTime() - 6 * DAY_MS) });

    expect(computeFlags(exactlyAtThreshold, ctx).some((f) => f.key === "ageing")).toBe(false);
    expect(computeFlags(pastThreshold, ctx).some((f) => f.key === "ageing")).toBe(true);
  });

  it("ageing never fires on held or terminal-stage requests, however old", () => {
    const now = new Date("2026-09-05T00:00:00.000Z");
    const ctx = emptyContext({ now, ageingThresholdByDept: new Map([["dept-1", 1]]) });
    const veryOld = new Date(now.getTime() - 365 * DAY_MS);

    for (const stage of ["on_hold", "paid", "rejected", "withdrawn"]) {
      const row = baseRow({ stage, createdAt: veryOld });
      expect(computeFlags(row, ctx).some((f) => f.key === "ageing")).toBe(false);
    }
    // Same age, still open — the control proving the exemption above is
    // actually about stage, not about the threshold math being broken.
    const stillOpen = baseRow({ stage: "with_accounts", createdAt: veryOld });
    expect(computeFlags(stillOpen, ctx).some((f) => f.key === "ageing")).toBe(true);
  });

  it("due-soon fires only in to_pay, within the 48-hour window, red once overdue", () => {
    const now = new Date("2026-09-05T00:00:00.000Z");
    const ctx = emptyContext({ now });

    const dueIn2Days = baseRow({ stage: "to_pay", dueDate: "2026-09-07" });
    const dueIn3Days = baseRow({ stage: "to_pay", dueDate: "2026-09-08" });
    const overdue = baseRow({ stage: "to_pay", dueDate: "2026-09-01" });
    const sameDueDateWrongStage = baseRow({ stage: "with_accounts", dueDate: "2026-09-07" });

    const flagsWithin = computeFlags(dueIn2Days, ctx);
    expect(flagsWithin.some((f) => f.key === "due_soon" && f.severity === "amber")).toBe(true);

    expect(computeFlags(dueIn3Days, ctx).some((f) => f.key === "due_soon")).toBe(false);

    const flagsOverdue = computeFlags(overdue, ctx);
    expect(flagsOverdue.some((f) => f.key === "due_soon" && f.severity === "red")).toBe(true);

    expect(computeFlags(sameDueDateWrongStage, ctx).some((f) => f.key === "due_soon")).toBe(false);
  });

  it("unanswered_query, repeat_amount and bank_changed are plain membership checks against the context", () => {
    const ctx = emptyContext({
      openQueryRequestIds: new Set(["r1"]),
      repeatAmountRequestIds: new Set(["r2"]),
      bankChangedRequestIds: new Set(["r3"]),
    });

    const flagsOf = (id: string): Flag[] => computeFlags(baseRow({ id }), ctx);

    expect(flagsOf("r1").map((f) => f.key)).toEqual(["unanswered_query"]);
    expect(flagsOf("r2").map((f) => f.key)).toEqual(["repeat_amount"]);
    expect(flagsOf("r3").map((f) => f.key)).toEqual(["bank_changed"]);
    expect(flagsOf("r4")).toEqual([]);
  });
});

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
    .values({ name: `Flags Test ${label} ${nonce}`, email: `flags-test-${label}-${nonce}@example.invalid`, passwordHash: await hashSecret("unused") })
    .returning({ id: user.id });
  return u;
}

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

async function raiseTestRequest(overrides: { amountMinor?: number; invoiceNo?: string; invoiceDate?: string } = {}): Promise<string> {
  const file = await uploadTestFile();
  const result = await submitRequest({
    userId: requesterUser.id,
    ip: META.ip,
    userAgent: META.userAgent,
    departmentId: deptA.id,
    amountMinor: overrides.amountMinor ?? 50000,
    invoiceNo: overrides.invoiceNo,
    invoiceDate: overrides.invoiceDate,
    attachments: [file],
  });
  if (!result.ok) throw new Error(result.error);
  return result.requestId;
}

async function makeVendorWithBank(label: string): Promise<string> {
  const seedRequestId = await raiseTestRequest();
  const created = await createVendor(accountantUser.id, "accountant", seedRequestId, { name: `Flags ${label} ${nonce}` }, META);
  if (!created.ok) throw new Error(created.error);
  createdVendorIds.push(created.id);
  await setVendorBank(accountantUser.id, created.id, {
    beneficiaryName: `Flags ${label} ${nonce}`,
    accountNumber: "000111222333",
    ifsc: "TEST0001111",
    branch: null,
    effectiveFrom: "2026-01-01",
  });
  return created.id;
}

async function approveAndAccount(requestId: string, vendorId: string, opts: { cycle: "unspecified" | "immediate" | "dated"; dueDate?: string | null; bookedOn?: string }) {
  const approveResult = await approveRequest(approverUser.id, requestId, { cycle: opts.cycle, dueDate: opts.dueDate ?? null, noteToAccountsAndPayer: null }, META);
  if (!approveResult.ok) throw new Error(approveResult.error);
  const accountResult = await accountRequest(
    accountantUser.id,
    requestId,
    { companyId: companyX.id, vendorId, headId: head.id, voucherNo: `PV-${nonce}-${randomUUID().slice(0, 8)}`, bookedOn: opts.bookedOn ?? "2026-01-01" },
    META,
  );
  if (!accountResult.ok) throw new Error(accountResult.error);
}

async function verifyIfNeeded(requestId: string) {
  const readiness = await checkPaymentBankReadiness(payerUser.id, requestId);
  if (!readiness.ready && readiness.reason === "unverified") {
    const result = await verifyVendorBank(payerUser.id, requestId, readiness.bank.id, META);
    if (!result.ok) throw new Error(result.error);
  }
}

async function fetchFlags(actorId: string, role: Role, requestIds: string[]): Promise<Map<string, Flag[]>> {
  return withGrantScope(actorId, role, async (tx) => {
    const rows = await tx.select().from(request).where(inArray(request.id, requestIds));
    const ctx = await loadFlagContext(tx, rows);
    const map = new Map<string, Flag[]>();
    for (const r of rows) map.set(r.id, computeFlags(r, ctx));
    return map;
  });
}

beforeAll(async () => {
  [deptA] = await dbOwner.insert(department).values({ name: `Flags Test Dept A ${nonce}`, code: `FLG-A-${nonce}`, ageingThresholdDays: 30 }).returning({ id: department.id });
  [companyX] = await dbOwner.insert(company).values({ name: `Flags Test Co X ${nonce}`, legalName: `Flags Test Co X ${nonce} Pvt Ltd` }).returning({ id: company.id });
  [head] = await dbOwner.insert(headOfAccount).values({ name: `Flags Test Head ${nonce}`, code: `FLG-H-${nonce}` }).returning({ id: headOfAccount.id });

  requesterUser = await makeUser("requester");
  approverUser = await makeUser("approver");
  accountantUser = await makeUser("accountant");
  payerUser = await makeUser("payer");

  await grant(requesterUser.id, "requester", { deptIds: [deptA.id] });
  await grant(approverUser.id, "approver", { deptIds: [deptA.id] });
  await grant(accountantUser.id, "accountant", { companyIds: [companyX.id] });
  await grant(payerUser.id, "payer", { companyIds: [companyX.id] });
}, 60_000);

afterAll(async () => {
  const userIds = [requesterUser.id, approverUser.id, accountantUser.id, payerUser.id];

  const reqs = await dbOwner.select({ id: request.id }).from(request).where(inArray(request.departmentId, [deptA.id]));
  const reqIds = reqs.map((r) => r.id);
  if (reqIds.length > 0) {
    await dbOwner.delete(payment).where(inArray(payment.requestId, reqIds));
    await dbOwner.delete(accounting).where(inArray(accounting.requestId, reqIds));
    await dbOwner.delete(query).where(inArray(query.requestId, reqIds));
    await dbOwner.delete(event).where(inArray(event.requestId, reqIds));
    await dbOwner.delete(requestFile).where(inArray(requestFile.requestId, reqIds));
    await dbOwner.delete(request).where(inArray(request.id, reqIds));
  }
  await dbOwner.delete(roleGrant).where(inArray(roleGrant.userId, userIds));
  if (createdVendorIds.length > 0) {
    await dbOwner.delete(vendorBank).where(inArray(vendorBank.vendorId, createdVendorIds));
    await dbOwner.delete(vendor).where(inArray(vendor.id, createdVendorIds));
  }
  await dbOwner.delete(headOfAccount).where(inArray(headOfAccount.id, [head.id]));
  await dbOwner.delete(department).where(inArray(department.id, [deptA.id]));
  await dbOwner.delete(company).where(inArray(company.id, [companyX.id]));
  await dbOwner.delete(user).where(inArray(user.id, userIds));
  await closeOwnerConnection();
}, 60_000);

describe("computed flags against the real DB (the phase-12 gate)", () => {
  it("ageing flag appears on an old, still-open request and not on an equally old held one", async () => {
    const openId = await raiseTestRequest();
    const heldId = await raiseTestRequest();

    const veryOld = new Date(Date.now() - 40 * DAY_MS); // deptA's threshold is 30 days
    await dbOwner.update(request).set({ createdAt: veryOld }).where(inArray(request.id, [openId, heldId]));

    const holdResult = await holdRequest(approverUser.id, heldId, { reviewOn: isoDate(14), subReason: "short_supply", reason: "test fixture" }, META);
    expect(holdResult.ok).toBe(true);

    const flagsByRequest = await fetchFlags(approverUser.id, "approver", [openId, heldId]);
    expect(flagsByRequest.get(openId)?.some((f) => f.key === "ageing")).toBe(true);
    expect(flagsByRequest.get(heldId)?.some((f) => f.key === "ageing")).toBe(false);
  });

  it("unanswered query flag appears when raised and disappears once answered", async () => {
    const requestId = await raiseTestRequest();

    const raised = await raiseQuery(approverUser.id, requestId, { directedAt: ["requester"], question: "Which department does this book to?" }, META);
    expect(raised.ok).toBe(true);
    if (!raised.ok) return;

    let flagsByRequest = await fetchFlags(approverUser.id, "approver", [requestId]);
    expect(flagsByRequest.get(requestId)?.some((f) => f.key === "unanswered_query")).toBe(true);

    const answered = await answerQuery(requesterUser.id, requestId, raised.queryId, { answer: "Canteen & Provisions" }, META);
    expect(answered.ok).toBe(true);

    flagsByRequest = await fetchFlags(approverUser.id, "approver", [requestId]);
    expect(flagsByRequest.get(requestId)?.some((f) => f.key === "unanswered_query")).toBe(false);
  });

  it("due-date flag appears within 48h while to_pay and clears once paid", async () => {
    const vendorId = await makeVendorWithBank("Due Soon Vendor");
    const requestId = await raiseTestRequest();

    await approveAndAccount(requestId, vendorId, { cycle: "dated", dueDate: isoDate(1) });
    await verifyIfNeeded(requestId);

    let flagsByRequest = await fetchFlags(payerUser.id, "payer", [requestId]);
    expect(flagsByRequest.get(requestId)?.some((f) => f.key === "due_soon")).toBe(true);

    const payResult = await payRequest(
      payerUser.id,
      requestId,
      { fromAccount: { id: "acc-1", label: "Main", bankName: "Test Bank", accountNumber: "000111", ifsc: "TEST0001" }, mode: "neft", valueDate: isoDate(0), amountMinor: 50000, tdsMinor: 0, reference: `UTR-${nonce}-duesoon` },
      META,
    );
    expect(payResult.ok).toBe(true);

    flagsByRequest = await fetchFlags(payerUser.id, "payer", [requestId]);
    expect(flagsByRequest.get(requestId)?.some((f) => f.key === "due_soon")).toBe(false);
  });

  it("repeat-amount flag fires for two same-vendor-same-month-same-amount requests, not for a different amount", async () => {
    const vendorId = await makeVendorWithBank("Repeat Amount Vendor");
    const amountMinor = 123400;

    const reqA = await raiseTestRequest({ amountMinor, invoiceNo: `INV-${nonce}-RPT-A`, invoiceDate: "2026-06-05" });
    const reqB = await raiseTestRequest({ amountMinor, invoiceNo: `INV-${nonce}-RPT-B`, invoiceDate: "2026-06-20" });
    const reqC = await raiseTestRequest({ amountMinor: 987600, invoiceNo: `INV-${nonce}-RPT-C`, invoiceDate: "2026-06-25" });

    for (const id of [reqA, reqB, reqC]) {
      await approveAndAccount(id, vendorId, { cycle: "immediate", bookedOn: "2026-06-25" });
    }

    const flagsByRequest = await fetchFlags(accountantUser.id, "accountant", [reqA, reqB, reqC]);
    expect(flagsByRequest.get(reqA)?.some((f) => f.key === "repeat_amount")).toBe(true);
    expect(flagsByRequest.get(reqB)?.some((f) => f.key === "repeat_amount")).toBe(true);
    expect(flagsByRequest.get(reqC)?.some((f) => f.key === "repeat_amount")).toBe(false);
  });

  it("bank-changed flag appears on an open request for a vendor once its bank is unverified, and clears once reverified", async () => {
    const vendorId = await makeVendorWithBank("Bank Changed Vendor");
    const requestId = await raiseTestRequest();
    await approveAndAccount(requestId, vendorId, { cycle: "immediate" });

    // Freshly entered, never verified — the flag treats this the same as
    // a genuine change: the payer hasn't confirmed the bank on file yet.
    let flagsByRequest = await fetchFlags(accountantUser.id, "accountant", [requestId]);
    expect(flagsByRequest.get(requestId)?.some((f) => f.key === "bank_changed")).toBe(true);

    await verifyIfNeeded(requestId);
    flagsByRequest = await fetchFlags(accountantUser.id, "accountant", [requestId]);
    expect(flagsByRequest.get(requestId)?.some((f) => f.key === "bank_changed")).toBe(false);

    // A fresh bank change re-flags this SAME already-open request — the
    // live read behind "a bank change flags every open request"
    // (concept-v2.html §10), with zero per-request state to update.
    await setVendorBank(accountantUser.id, vendorId, {
      beneficiaryName: `Flags Bank Changed Vendor ${nonce}`,
      accountNumber: "000999888777",
      ifsc: "TEST0002222",
      branch: null,
      effectiveFrom: "2026-01-02",
    });
    flagsByRequest = await fetchFlags(accountantUser.id, "accountant", [requestId]);
    expect(flagsByRequest.get(requestId)?.some((f) => f.key === "bank_changed")).toBe(true);
  });
});
