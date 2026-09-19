import { randomUUID } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeOwnerConnection, dbOwner } from "../scripts/db-owner";
import { withGrantScope } from "../src/db/runtime";
import { accounting, company, department, event, headOfAccount, payment, request, requestFile, roleGrant, user, vendor, vendorBank } from "../src/db/schema";
import { hashSecret } from "../src/auth/password";
import { submitRequest, type Attachment, type SubmitRequestParams } from "../src/requests/captureCore";
import { accountRequest, approveRequest, attachInvoice, payRequest } from "../src/requests/transitions";
import { presignPutUrl } from "../src/storage/r2";
import { buildStorageKey } from "../src/storage/storageKey";

// Advances and part-payments (concept-v2.html section 09). Real Supabase,
// real R2, same philosophy as tests/desks.test.ts. What this file proves:
// a request can be paid more than once but never above what it can settle,
// an advance stays open after its money moves and only the requester who
// raised it can attach the tax invoice that releases the balance, and none
// of it weakens the audit chain.

const nonce = randomUUID().slice(0, 8);
// The two longest chains here (raise -> approve -> account, then several
// payments or an attach) run past the global 120s when the link to the
// ap-south-1 project is slow: both hit exactly that ceiling on a local run
// at ~1s per round trip. Sized for that, not for a fast day.
const HEAVY_TEST_TIMEOUT = 360_000;
const META = { ip: "203.0.113.40", userAgent: "vitest" };
const ACCOUNT = { id: "acc-1", label: "Main", bankName: "Test Bank", accountNumber: "000111", ifsc: "TEST0001" };

async function uploadTestFile(): Promise<Attachment> {
  const fileId = randomUUID();
  const mime = "application/pdf";
  const storageKey = buildStorageKey("bills", fileId, mime);
  const uploadUrl = await presignPutUrl(storageKey, mime);
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  const response = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": mime }, body: bytes });
  if (!response.ok) throw new Error(`Test fixture upload failed: ${response.status}`);
  // Unique sha256 per file: capture-time duplicate control matches on it
  // org-wide, so a fixed value would make every request look like a repeat.
  return { fileId, storageKey, mime, byteLength: bytes.length, sha256: randomUUID().padEnd(64, "0") };
}

let dept: { id: string };
let companyX: { id: string };
let head: { id: string };
let testVendor: { id: string };
let requester: { id: string };
let otherRequester: { id: string };
let approver: { id: string };
let accountant: { id: string };
let payer: { id: string };

async function makeUser(label: string) {
  const [u] = await dbOwner
    .insert(user)
    .values({ name: `Advance Test ${label} ${nonce}`, email: `advance-test-${label}-${nonce}@example.invalid`, passwordHash: await hashSecret("unused") })
    .returning({ id: user.id });
  return u;
}

async function grant(userId: string, role: string) {
  await dbOwner.insert(roleGrant).values({
    userId,
    role: role as (typeof roleGrant.$inferInsert)["role"],
    deptScope: role === "requester" ? "list" : "global",
    departmentIds: role === "requester" ? [dept.id] : undefined,
    companyScope: role === "accountant" || role === "payer" ? "global" : "n/a",
    grantedBy: userId,
  });
}

beforeAll(async () => {
  [dept] = await dbOwner.insert(department).values({ name: `Advance Test Dept ${nonce}`, code: `ADV-${nonce}`, ageingThresholdDays: 30 }).returning({ id: department.id });
  [companyX] = await dbOwner.insert(company).values({ name: `Advance Test Co ${nonce}`, legalName: `Advance Test Co Pvt Ltd ${nonce}` }).returning({ id: company.id });
  [head] = await dbOwner.insert(headOfAccount).values({ name: `Advance Test Head ${nonce}`, code: `ADVH-${nonce}` }).returning({ id: headOfAccount.id });

  requester = await makeUser("requester");
  otherRequester = await makeUser("requester-other");
  approver = await makeUser("approver");
  accountant = await makeUser("accountant");
  payer = await makeUser("payer");
  await grant(requester.id, "requester");
  await grant(otherRequester.id, "requester");
  await grant(approver.id, "approver");
  await grant(accountant.id, "accountant");
  await grant(payer.id, "payer");

  [testVendor] = await dbOwner.insert(vendor).values({ name: `Advance Test Vendor ${nonce}`, createdBy: accountant.id }).returning({ id: vendor.id });
  // Pre-verified, inserted directly: the payer-verification gate is not what
  // this file tests (tests/payer-verification.test.ts is).
  await dbOwner.insert(vendorBank).values({
    vendorId: testVendor.id,
    beneficiaryName: `Advance Test Vendor ${nonce}`,
    accountNumberEncrypted: "unused",
    accountNumberLast4: "0000",
    ifsc: "TEST0000000",
    effectiveFrom: "2026-01-01",
    enteredBy: accountant.id,
    enteredAsRole: "accountant",
    verifiedBy: payer.id,
    verifiedAt: new Date(),
  });
});

afterAll(async () => {
  const userIds = [requester.id, otherRequester.id, approver.id, accountant.id, payer.id];
  const reqs = await dbOwner.select({ id: request.id }).from(request).where(eq(request.departmentId, dept.id));
  const reqIds = reqs.map((r) => r.id);
  if (reqIds.length > 0) {
    await dbOwner.delete(payment).where(inArray(payment.requestId, reqIds));
    await dbOwner.delete(accounting).where(inArray(accounting.requestId, reqIds));
    await dbOwner.delete(event).where(inArray(event.requestId, reqIds));
    await dbOwner.delete(requestFile).where(inArray(requestFile.requestId, reqIds));
    await dbOwner.delete(request).where(inArray(request.id, reqIds));
  }
  await dbOwner.delete(roleGrant).where(inArray(roleGrant.userId, userIds));
  await dbOwner.delete(vendorBank).where(eq(vendorBank.vendorId, testVendor.id));
  await dbOwner.delete(vendor).where(eq(vendor.id, testVendor.id));
  await dbOwner.delete(headOfAccount).where(eq(headOfAccount.id, head.id));
  await dbOwner.delete(department).where(eq(department.id, dept.id));
  await dbOwner.delete(company).where(eq(company.id, companyX.id));
  await dbOwner.delete(user).where(inArray(user.id, userIds));
  await closeOwnerConnection();
});

async function raise(overrides: Partial<SubmitRequestParams>) {
  return submitRequest({
    userId: requester.id,
    ip: META.ip,
    userAgent: META.userAgent,
    departmentId: dept.id,
    amountMinor: 1_000_000,
    attachments: [await uploadTestFile()],
    ...overrides,
  });
}

async function raiseToPayer(overrides: Partial<SubmitRequestParams>): Promise<string> {
  const result = await raise(overrides);
  if (!result.ok) throw new Error(result.error);
  const approved = await approveRequest(approver.id, result.requestId, { cycle: "immediate", dueDate: null, noteToAccountsAndPayer: null }, META);
  if (!approved.ok) throw new Error(approved.error);
  const accounted = await accountRequest(
    accountant.id,
    result.requestId,
    { companyId: companyX.id, vendorId: testVendor.id, headId: head.id, voucherNo: `ADV-${randomUUID().slice(0, 8)}`, bookedOn: "2026-09-01" },
    META,
  );
  if (!accounted.ok) throw new Error(accounted.error);
  return result.requestId;
}

function pay(requestId: string, amountMinor: number) {
  return payRequest(
    payer.id,
    requestId,
    { fromAccount: ACCOUNT, mode: "neft", valueDate: "2026-09-10", amountMinor, tdsMinor: 0, reference: `UTR-${randomUUID().slice(0, 12)}` },
    META,
  );
}

async function readRequest(requestId: string) {
  const [row] = await dbOwner.select().from(request).where(eq(request.id, requestId));
  return row;
}

async function eventTypes(requestId: string): Promise<string[]> {
  const rows = await dbOwner.select({ type: event.type }).from(event).where(eq(event.requestId, requestId)).orderBy(asc(event.at));
  return rows.map((r) => r.type);
}

async function assertChainIntact(requestId: string) {
  const rows = await dbOwner.select({ prevHash: event.prevHash, hash: event.hash }).from(event).where(eq(event.requestId, requestId)).orderBy(asc(event.at));
  expect(rows[0].prevHash).toBeNull();
  for (let i = 1; i < rows.length; i++) expect(rows[i].prevHash).toBe(rows[i - 1].hash);
}

describe("capture records what the requester actually asked for", () => {
  it("an advance keeps its quotation number out of the invoice key and records the ask", async () => {
    const result = await raise({ kind: "advance", amountMinor: 840_000_00, payNowMinor: 336_000_00, payNowReason: "Will not start without it", quotationNo: "QT-2026-084", invoiceExpectedBy: "2026-10-15" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = await readRequest(result.requestId);
    expect(row.kind).toBe("advance");
    expect(row.payNowMinor).toBe(336_000_00);
    expect(row.quotationNo).toBe("QT-2026-084");
    expect(row.invoiceExpectedBy).toBe("2026-10-15");
    // The whole point of the separate column: nothing here can look like a
    // tax invoice to the duplicate index.
    expect(row.invoiceNo).toBeNull();
    expect(row.invoiceKey).toBeNull();
    expect(row.stage).toBe("awaiting_approval");
  });

  it("refuses an advance with no amount, and any pay-now above the total", async () => {
    const noAmount = await raise({ kind: "advance" });
    expect(noAmount.ok).toBe(false);
    const tooMuch = await raise({ kind: "advance", amountMinor: 100_000, payNowMinor: 100_001 });
    expect(tooMuch.ok).toBe(false);
    const tooMuchPart = await raise({ amountMinor: 100_000, payNowMinor: 100_001 });
    expect(tooMuchPart.ok).toBe(false);
  });

  it("stores a part payment as one, and a 'part' equal to the whole as a plain full payment", async () => {
    const part = await raise({ amountMinor: 500_000, payNowMinor: 200_000, payNowReason: "Some items disputed" });
    const whole = await raise({ amountMinor: 500_000, payNowMinor: 500_000 });
    if (!part.ok || !whole.ok) throw new Error("capture failed");
    expect((await readRequest(part.requestId)).payNowMinor).toBe(200_000);
    expect((await readRequest(part.requestId)).kind).toBe("invoice");
    expect((await readRequest(whole.requestId)).payNowMinor).toBeNull();
  });
});

describe("part payment: more than one payment, never above what the request can settle", () => {
  it("part, then the remainder, closes only when the balance reaches zero", async () => {
    const requestId = await raiseToPayer({ amountMinor: 1_000_000, payNowMinor: 400_000 });

    expect((await pay(requestId, 400_000)).ok).toBe(true);
    let row = await readRequest(requestId);
    expect(row.stage).toBe("to_pay");

    expect((await pay(requestId, 600_000)).ok).toBe(true);
    row = await readRequest(requestId);
    expect(row.stage).toBe("paid");

    expect(await eventTypes(requestId)).toEqual(["request.raised", "request.approved", "request.accounted", "request.part_paid", "request.paid"]);
    const payments = await dbOwner.select().from(payment).where(eq(payment.requestId, requestId));
    expect(payments.reduce((sum, p) => sum + p.amountMinor, 0)).toBe(1_000_000);
    await assertChainIntact(requestId);
  });

  it("refuses a payment that would take the total above the request amount, and writes nothing", { timeout: HEAVY_TEST_TIMEOUT }, async () => {
    const requestId = await raiseToPayer({ amountMinor: 1_000_000 });

    const tooMuch = await pay(requestId, 1_000_001);
    expect(tooMuch.ok).toBe(false);
    if (!tooMuch.ok) expect(tooMuch.error).toContain("balance");
    expect((await readRequest(requestId)).stage).toBe("to_pay");
    expect(await dbOwner.select().from(payment).where(eq(payment.requestId, requestId))).toHaveLength(0);

    expect((await pay(requestId, 700_000)).ok).toBe(true);
    const overBalance = await pay(requestId, 300_001);
    expect(overBalance.ok).toBe(false);
    expect(await dbOwner.select().from(payment).where(eq(payment.requestId, requestId))).toHaveLength(1);
  });

  it("two payments raced at the same moment cannot together exceed the amount", async () => {
    const requestId = await raiseToPayer({ amountMinor: 1_000_000 });
    const [a, b] = await Promise.all([pay(requestId, 700_000), pay(requestId, 700_000)]);
    // The row lock serialises them: exactly one lands, the other is told the balance.
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const payments = await dbOwner.select().from(payment).where(eq(payment.requestId, requestId));
    expect(payments).toHaveLength(1);
  });
});

describe("advance: the request stays open until the tax invoice arrives", () => {
  it("advance paid -> awaiting_invoice -> invoice attached -> balance -> paid", { timeout: HEAVY_TEST_TIMEOUT }, async () => {
    const requestId = await raiseToPayer({ kind: "advance", amountMinor: 1_000_000, payNowMinor: 400_000, quotationNo: `QT-${nonce}` });

    // An advance can't quietly become a larger payment before the invoice is in.
    const tooBig = await pay(requestId, 400_001);
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.error).toContain("tax invoice");

    expect((await pay(requestId, 400_000)).ok).toBe(true);
    let row = await readRequest(requestId);
    expect(row.stage).toBe("awaiting_invoice");
    expect(row.invoiceAttachedAt).toBeNull();

    const invoiceFile = await uploadTestFile();

    // Only the requester who raised it. RLS admits the whole department pool,
    // so this ownership check is what actually restricts it.
    const wrongPerson = await attachInvoice(otherRequester.id, requestId, { invoiceNo: `INV-${nonce}`, invoiceDate: "2026-10-01", amountMinor: 900_000, attachments: [invoiceFile] }, META);
    expect(wrongPerson.ok).toBe(false);

    // An invoice below what was already paid needs a human (a refund may be due).
    const belowAdvance = await attachInvoice(requester.id, requestId, { invoiceNo: `INV-${nonce}`, invoiceDate: "2026-10-01", amountMinor: 300_000, attachments: [invoiceFile] }, META);
    expect(belowAdvance.ok).toBe(false);
    expect((await readRequest(requestId)).stage).toBe("awaiting_invoice");

    const attached = await attachInvoice(requester.id, requestId, { invoiceNo: `INV-${nonce}`, invoiceDate: "2026-10-01", amountMinor: 900_000, attachments: [invoiceFile] }, META);
    expect(attached.ok).toBe(true);
    row = await readRequest(requestId);
    expect(row.stage).toBe("to_pay");
    expect(row.amountMinor).toBe(900_000);
    expect(row.invoiceNo).toBe(`INV-${nonce}`);
    expect(row.invoiceAttachedAt).not.toBeNull();

    // Balance is the invoice less the advance, never a typed figure.
    const overBalance = await pay(requestId, 500_001);
    expect(overBalance.ok).toBe(false);
    expect((await pay(requestId, 500_000)).ok).toBe(true);
    expect((await readRequest(requestId)).stage).toBe("paid");

    expect(await eventTypes(requestId)).toEqual([
      "request.raised",
      "request.approved",
      "request.accounted",
      "request.advance_paid",
      "request.invoice_attached",
      "request.paid",
    ]);
    await assertChainIntact(requestId);
  });

  it("refuses to attach an invoice to anything that is not a paid advance", async () => {
    const result = await raise({ amountMinor: 100_000 });
    if (!result.ok) throw new Error(result.error);
    const attempt = await attachInvoice(requester.id, result.requestId, { invoiceNo: "X-1", invoiceDate: "2026-10-01", amountMinor: 100_000, attachments: [await uploadTestFile()] }, META);
    expect(attempt.ok).toBe(false);
  });

  it("a paid advance sits at awaiting_invoice, visible to the requester who owes the invoice", async () => {
    const requestId = await raiseToPayer({ kind: "advance", amountMinor: 500_000, payNowMinor: 200_000 });
    expect((await pay(requestId, 200_000)).ok).toBe(true);
    const asRequester = await withGrantScope(requester.id, "requester", (tx) => tx.select({ stage: request.stage }).from(request).where(eq(request.id, requestId)));
    expect(asRequester[0].stage).toBe("awaiting_invoice");
  });
});
