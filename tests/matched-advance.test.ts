import { randomUUID } from "node:crypto";
import { asc, eq, inArray, or, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeOwnerConnection, dbOwner } from "../scripts/db-owner";
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
import { checkOpenAdvances } from "../src/duplicates/duplicateCore";
import { submitRequest, type Attachment, type SubmitRequestParams } from "../src/requests/captureCore";
import { accountRequest, approveRequest, attachToOpenAdvance, payRequest } from "../src/requests/transitions";
import { presignPutUrl } from "../src/storage/r2";
import { buildStorageKey } from "../src/storage/storageKey";

// The sixth duplicate verdict (concept-v2.html section 09): a new bill from a
// vendor who already has an advance paid and its tax invoice awaited. Same
// philosophy as tests/duplicate-control.test.ts: the real duplicateCore.ts /
// captureCore.ts / transitions.ts against the real dev Supabase project and
// R2, no mocks. Every test builds its own vendor, so one test's open advance
// can never be another test's surprise match.
//
// Explicitly browser-only, NOT attempted here: the accountant panel's amber
// "Attach to REQ-xxxx" card and the raise wizard's "Is this the final bill for
// an advance?" card.

const nonce = randomUUID().slice(0, 8);
const NONCE = nonce.toUpperCase();
// Raise -> approve -> account -> pay, then more. Same reasoning as
// tests/advance-part-payment.test.ts: sized for a slow link, not a fast one.
const HEAVY_TEST_TIMEOUT = 360_000;
const META = { ip: "203.0.113.50", userAgent: "vitest" };
const ACCOUNT = { id: "acc-1", label: "Main", bankName: "Test Bank", accountNumber: "000111", ifsc: "TEST0001" };
const QUOTED = 1_000_000;
const ADVANCE_PAID = 400_000;

async function uploadTestFile(): Promise<Attachment> {
  const fileId = randomUUID();
  const mime = "application/pdf";
  const storageKey = buildStorageKey("bills", fileId, mime);
  const uploadUrl = await presignPutUrl(storageKey, mime);
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  const response = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": mime }, body: bytes });
  if (!response.ok) throw new Error(`Test fixture upload failed: ${response.status}`);
  // Unique per file: the capture-time checksum check matches org-wide.
  return { fileId, storageKey, mime, byteLength: bytes.length, sha256: randomUUID().padEnd(64, "0") };
}

let deptA: { id: string };
let deptB: { id: string };
let companyX: { id: string };
let head: { id: string };

let requester: { id: string };
let otherRequester: { id: string };
let requesterB: { id: string };
let approver: { id: string };
let accountant: { id: string };
let accountantDeptA: { id: string };
let payer: { id: string };

const createdVendorIds: string[] = [];
let vendorSeq = 0;

async function makeUser(label: string): Promise<{ id: string }> {
  const [u] = await dbOwner
    .insert(user)
    .values({ name: `Matched Adv ${label} ${nonce}`, email: `matched-adv-${label}-${nonce}@example.invalid`, passwordHash: await hashSecret("unused") })
    .returning({ id: user.id });
  return u;
}

async function grant(userId: string, role: "requester" | "approver" | "accountant" | "payer", opts: { deptIds?: string[] } = {}) {
  await dbOwner.insert(roleGrant).values({
    userId,
    role,
    deptScope: opts.deptIds ? "list" : "global",
    departmentIds: opts.deptIds,
    companyScope: role === "accountant" || role === "payer" ? "global" : "n/a",
    grantedBy: userId,
  });
}

// A vendor with a GSTIN (so vendor_key is the GSTIN, exactly what a real
// vendor carries) and a payer-verified bank row, inserted directly: bank
// verification is not what this file tests.
async function makeVendor(label: string): Promise<{ id: string; name: string; gstin: string }> {
  vendorSeq += 1;
  const name = `Matched Adv ${label} Works ${nonce}`;
  const gstin = `27ADV${NONCE}${String(vendorSeq).padStart(2, "0")}Z5`;
  const [v] = await dbOwner.insert(vendor).values({ name, gstin, createdBy: accountant.id }).returning({ id: vendor.id });
  createdVendorIds.push(v.id);
  await dbOwner.insert(vendorBank).values({
    vendorId: v.id,
    beneficiaryName: name,
    accountNumberEncrypted: "unused",
    accountNumberLast4: "0000",
    ifsc: "TEST0000000",
    effectiveFrom: "2026-01-01",
    enteredBy: accountant.id,
    enteredAsRole: "accountant",
    verifiedBy: payer.id,
    verifiedAt: new Date(),
  });
  return { id: v.id, name, gstin };
}

beforeAll(async () => {
  [deptA] = await dbOwner.insert(department).values({ name: `Matched Adv Dept A ${nonce}`, code: `MADV-A-${nonce}`, ageingThresholdDays: 30 }).returning({ id: department.id });
  [deptB] = await dbOwner.insert(department).values({ name: `Matched Adv Dept B ${nonce}`, code: `MADV-B-${nonce}`, ageingThresholdDays: 30 }).returning({ id: department.id });
  [companyX] = await dbOwner.insert(company).values({ name: `Matched Adv Co ${nonce}`, legalName: `Matched Adv Co ${nonce} Pvt Ltd` }).returning({ id: company.id });
  [head] = await dbOwner.insert(headOfAccount).values({ name: `Matched Adv Head ${nonce}`, code: `MADV-H-${nonce}` }).returning({ id: headOfAccount.id });

  requester = await makeUser("requester");
  otherRequester = await makeUser("requester-other");
  requesterB = await makeUser("requester-b");
  approver = await makeUser("approver");
  accountant = await makeUser("accountant");
  accountantDeptA = await makeUser("accountant-dept-a");
  payer = await makeUser("payer");

  await grant(requester.id, "requester", { deptIds: [deptA.id] });
  await grant(otherRequester.id, "requester", { deptIds: [deptA.id] });
  await grant(requesterB.id, "requester", { deptIds: [deptB.id] });
  await grant(approver.id, "approver");
  await grant(accountant.id, "accountant");
  // Sees department A only: an advance in department B is one they can be
  // told exists but cannot see into, so cannot attach to.
  await grant(accountantDeptA.id, "accountant", { deptIds: [deptA.id] });
  await grant(payer.id, "payer");
}, 60_000);

afterAll(async () => {
  const userIds = [requester.id, otherRequester.id, requesterB.id, approver.id, accountant.id, accountantDeptA.id, payer.id];

  const reqs = await dbOwner.select({ id: request.id }).from(request).where(inArray(request.departmentId, [deptA.id, deptB.id]));
  const reqIds = reqs.map((r) => r.id);
  if (reqIds.length > 0) {
    await dbOwner.delete(duplicateCheck).where(or(inArray(duplicateCheck.requestId, reqIds), inArray(duplicateCheck.matchedRequestId, reqIds)));
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

// ---- fixtures ---------------------------------------------------------

async function raise(overrides: Partial<SubmitRequestParams> = {}) {
  return submitRequest({
    userId: requester.id,
    ip: META.ip,
    userAgent: META.userAgent,
    departmentId: deptA.id,
    amountMinor: 900_000,
    attachments: [await uploadTestFile()],
    ...overrides,
  });
}

async function raiseOk(overrides: Partial<SubmitRequestParams> = {}): Promise<{ requestId: string; ref: string }> {
  const result = await raise(overrides);
  if (!result.ok) throw new Error(result.error);
  return { requestId: result.requestId, ref: result.ref };
}

async function approve(requestId: string) {
  const r = await approveRequest(approver.id, requestId, { cycle: "immediate", dueDate: null, noteToAccountsAndPayer: null }, META);
  if (!r.ok) throw new Error(r.error);
}

function account(actorId: string, requestId: string, vendorId: string, extra: { declineOpenAdvance?: { reason: string } } = {}) {
  return accountRequest(
    actorId,
    requestId,
    { companyId: companyX.id, vendorId, headId: head.id, voucherNo: `MADV-${randomUUID().slice(0, 8)}`, bookedOn: "2026-09-01", ...extra },
    META,
  );
}

function pay(requestId: string, amountMinor: number) {
  return payRequest(
    payer.id,
    requestId,
    { fromAccount: ACCOUNT, mode: "neft", valueDate: "2026-09-10", amountMinor, tdsMinor: 0, reference: `UTR-${randomUUID().slice(0, 12)}` },
    META,
  );
}

// An advance for `v`, raised by `by` in `deptId`, taken all the way to
// awaiting_invoice: the state the sixth verdict is about. The advance's own
// accounting skips the open-advance gate on purpose (only a bill can be the
// invoice an advance waits for).
async function makeOpenAdvance(v: { id: string; name: string }, opts: { by?: string; deptId?: string } = {}): Promise<{ requestId: string; ref: string }> {
  const raised = await raiseOk({
    userId: opts.by ?? requester.id,
    departmentId: opts.deptId ?? deptA.id,
    kind: "advance",
    amountMinor: QUOTED,
    payNowMinor: ADVANCE_PAID,
    quotationNo: `QT-${randomUUID().slice(0, 6)}`,
    vendor: v.name,
  });
  await approve(raised.requestId);
  const accounted = await account(accountant.id, raised.requestId, v.id);
  if (!accounted.ok) throw new Error(accounted.error);
  const paid = await pay(raised.requestId, ADVANCE_PAID);
  if (!paid.ok) throw new Error(paid.error);
  expect((await readRequest(raised.requestId)).stage).toBe("awaiting_invoice");
  return raised;
}

// A bill at the accounts desk. No vendor text and no GSTIN on it by default
// — extraction found nothing and the requester typed nothing — so capture has
// nothing to match on and the accounts desk is the first thing that can.
async function billAtAccounts(overrides: Partial<SubmitRequestParams> = {}): Promise<{ requestId: string; ref: string }> {
  const raised = await raiseOk({ invoiceNo: `INV-${randomUUID().slice(0, 8)}`, invoiceDate: "2026-10-01", ...overrides });
  await approve(raised.requestId);
  return raised;
}

async function readRequest(requestId: string) {
  const [row] = await dbOwner.select().from(request).where(eq(request.id, requestId));
  return row;
}

async function eventsOf(requestId: string) {
  return dbOwner.select().from(event).where(eq(event.requestId, requestId)).orderBy(asc(event.at));
}

async function verdictRows(requestId: string) {
  return dbOwner.select().from(duplicateCheck).where(eq(duplicateCheck.requestId, requestId));
}

async function assertChainIntact(requestId: string) {
  const rows = await eventsOf(requestId);
  expect(rows[0].prevHash).toBeNull();
  for (let i = 1; i < rows.length; i++) expect(rows[i].prevHash).toBe(rows[i - 1].hash);
}

function requestCountInDeptA() {
  return dbOwner.$count(request, eq(request.departmentId, deptA.id));
}

// ---- capture: the earlier, weaker half of the check -------------------

describe("matched_advance at capture (advisory: GSTIN and vendor name on the bill)", () => {
  it("asks instead of raising, records a decline with its reason, and writes nothing while unanswered", { timeout: HEAVY_TEST_TIMEOUT }, async () => {
    const v = await makeVendor("capture");
    const advance = await makeOpenAdvance(v);
    const before = await requestCountInDeptA();

    const asked = await raise({ gstinOnBill: v.gstin, vendor: "Spelled differently entirely" });
    expect(asked.ok).toBe(false);
    if (asked.ok) return;
    expect(asked.duplicate?.verdict).toBe("matched_advance");
    expect(asked.openAdvances).toHaveLength(1);
    expect(asked.openAdvances![0].requestId).toBe(advance.requestId);
    expect(asked.openAdvances![0].advance).toMatchObject({
      ref: advance.ref,
      quotedMinor: QUOTED,
      paidMinor: ADVANCE_PAID,
      recognisedBy: "gstin",
      raisedByActor: true,
    });
    // Refused before anything was written, not written and then flagged.
    expect(await requestCountInDeptA()).toBe(before);

    // A blank reason is not an answer.
    const blank = await raise({ gstinOnBill: v.gstin, declineOpenAdvance: { reason: "   " } });
    expect(blank.ok).toBe(false);
    expect(await requestCountInDeptA()).toBe(before);

    const declined = await raise({ gstinOnBill: v.gstin, declineOpenAdvance: { reason: "Separate job, different PO" } });
    expect(declined.ok).toBe(true);
    if (!declined.ok) return;

    const rows = await verdictRows(declined.requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      verdict: "matched_advance",
      matchedRequestId: advance.requestId,
      overriddenBy: requester.id,
      reason: "Separate job, different PO",
    });
    expect(rows[0].signals).toContain("open_advance");

    // The decline is in the trail as well as the verdict table.
    const [raisedEvent] = await eventsOf(declined.requestId);
    const after = raisedEvent.after as { duplicateVerdict: string; openAdvanceDeclineReason: string };
    expect(after.duplicateVerdict).toBe("matched_advance");
    expect(after.openAdvanceDeclineReason).toBe("Separate job, different PO");
  });

  it("matches on the vendor name with case and punctuation ignored — and not on a near miss, a short name, or another advance", { timeout: HEAVY_TEST_TIMEOUT }, async () => {
    const v = await makeVendor("names");
    const advance = await makeOpenAdvance(v);

    const byName = await raise({ vendor: `${v.name.toUpperCase()}.` });
    expect(byName.ok).toBe(false);
    if (!byName.ok) {
      expect(byName.duplicate?.verdict).toBe("matched_advance");
      expect(byName.openAdvances![0].requestId).toBe(advance.requestId);
      expect(byName.openAdvances![0].advance?.recognisedBy).toBe("vendor_name");
    }

    // One letter off is a different firm as far as an equality check goes.
    expect((await raise({ vendor: v.name.replace("Works", "Work") })).ok).toBe(true);
    // A short name never matches, however equal.
    expect((await raise({ vendor: "Abc" })).ok).toBe(true);
    // A second ADVANCE to the same vendor is not "the invoice that follows".
    const second = await raise({ vendor: v.name, kind: "advance", payNowMinor: 100_000, quotationNo: "QT-2" });
    expect(second.ok).toBe(true);
  });

  it("is silent when the vendor has nothing outstanding: an unpaid advance is not open", async () => {
    const v = await makeVendor("quiet");
    // Raised and waiting for approval: no money out, nothing to attach to yet.
    await raiseOk({ kind: "advance", amountMinor: QUOTED, payNowMinor: ADVANCE_PAID, quotationNo: "QT-U", vendor: v.name });

    const bill = await raise({ vendor: v.name, gstinOnBill: v.gstin });
    expect(bill.ok).toBe(true);
    if (bill.ok) expect(await verdictRows(bill.requestId)).toHaveLength(0);
  });

  it("a bill raised offline is not held on a question: the match is recorded unanswered and accounts asks again", { timeout: HEAVY_TEST_TIMEOUT }, async () => {
    const v = await makeVendor("offline");
    const advance = await makeOpenAdvance(v);

    const queued = await raise({ gstinOnBill: v.gstin, askAboutOpenAdvance: false });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const rows = await verdictRows(queued.requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ verdict: "matched_advance", matchedRequestId: advance.requestId, overriddenBy: null, reason: null });

    // ...and the accounts desk still gates it, on the exact vendor key.
    await approve(queued.requestId);
    const gated = await account(accountant.id, queued.requestId, v.id);
    expect(gated.ok).toBe(false);
    if (!gated.ok) expect(gated.duplicate?.verdict).toBe("matched_advance");
  });

  it("an advance in a department the requester can't see is redacted, but the question is still asked", { timeout: HEAVY_TEST_TIMEOUT }, async () => {
    const v = await makeVendor("redacted");
    await makeOpenAdvance(v, { by: requesterB.id, deptId: deptB.id });

    const asked = await raise({ gstinOnBill: v.gstin });
    expect(asked.ok).toBe(false);
    if (asked.ok) return;
    expect(asked.duplicate?.verdict).toBe("matched_advance");
    const match = asked.openAdvances![0];
    expect(match.viewableByActor).toBe(false);
    expect(match.advance).toBeNull();
    expect(match.stage).toBe("unknown");
    expect(match.viewerHint).toMatch(/^ask .+, an approver in that department$/);
  });
});

// ---- accounts: the exact, gating half ---------------------------------

describe("matched_advance at the accounts desk (vendor matched, so the key is exact)", () => {
  it("refuses to account a bill until it is attached or declined, and records the decline in the same transaction", { timeout: HEAVY_TEST_TIMEOUT }, async () => {
    const v = await makeVendor("gate");
    const advance = await makeOpenAdvance(v);
    const bill = await billAtAccounts();

    const asked = await account(accountant.id, bill.requestId, v.id);
    expect(asked.ok).toBe(false);
    if (asked.ok) return;
    expect(asked.duplicate?.verdict).toBe("matched_advance");
    expect(asked.openAdvances![0].advance).toMatchObject({ ref: advance.ref, quotedMinor: QUOTED, paidMinor: ADVANCE_PAID, recognisedBy: "vendor_key" });

    // Refused, so nothing moved and nothing was written.
    expect((await readRequest(bill.requestId)).stage).toBe("with_accounts");
    expect(await dbOwner.$count(accounting, eq(accounting.requestId, bill.requestId))).toBe(0);
    expect(await verdictRows(bill.requestId)).toHaveLength(0);

    expect((await account(accountant.id, bill.requestId, v.id, { declineOpenAdvance: { reason: "  " } })).ok).toBe(false);

    const declined = await account(accountant.id, bill.requestId, v.id, { declineOpenAdvance: { reason: "Second phase invoice, not the advance's" } });
    expect(declined.ok).toBe(true);
    expect((await readRequest(bill.requestId)).stage).toBe("to_pay");

    const rows = await verdictRows(bill.requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      verdict: "matched_advance",
      matchedRequestId: advance.requestId,
      overriddenBy: accountant.id,
      reason: "Second phase invoice, not the advance's",
    });
    expect(rows[0].signals).toContain("via_vendor_key");

    const accountedEvent = (await eventsOf(bill.requestId)).find((e) => e.type === "request.accounted");
    const after = accountedEvent!.after as { openAdvanceDeclineReason: string; openAdvanceDeclined: { requestId: string; ref: string }[] };
    expect(after.openAdvanceDeclineReason).toBe("Second phase invoice, not the advance's");
    expect(after.openAdvanceDeclined).toEqual([{ requestId: advance.requestId, ref: advance.ref }]);
    await assertChainIntact(bill.requestId);
  });

  it("lists every open advance for the vendor, oldest first, so the desk chooses rather than being handed one", { timeout: HEAVY_TEST_TIMEOUT }, async () => {
    const v = await makeVendor("two");
    const first = await makeOpenAdvance(v);
    // A second ADVANCE to a vendor who already has one open books through the
    // same accounts desk without the question — makeOpenAdvance accounting
    // it here is that assertion; only a bill can be the invoice that follows.
    const second = await makeOpenAdvance(v);
    const bill = await billAtAccounts();

    const asked = await account(accountant.id, bill.requestId, v.id);
    expect(asked.ok).toBe(false);
    if (asked.ok) return;
    expect(asked.openAdvances!.map((m) => m.requestId)).toEqual([first.requestId, second.requestId]);
  });

  it("an unviewable advance still has to be answered — the fact of it is not withheld to protect a scope boundary", { timeout: HEAVY_TEST_TIMEOUT }, async () => {
    const v = await makeVendor("scope");
    const inB = await makeOpenAdvance(v, { by: requesterB.id, deptId: deptB.id });
    const bill = await billAtAccounts();

    const asked = await account(accountantDeptA.id, bill.requestId, v.id);
    expect(asked.ok).toBe(false);
    if (asked.ok) return;
    expect(asked.openAdvances![0].requestId).toBe(inB.requestId);
    expect(asked.openAdvances![0].advance).toBeNull();

    // They can't attach to it: it isn't theirs to see, let alone change.
    const attach = await attachToOpenAdvance(accountantDeptA.id, bill.requestId, { advanceRequestId: inB.requestId, vendorId: v.id }, META);
    expect(attach.ok).toBe(false);
    expect((await readRequest(bill.requestId)).stage).toBe("with_accounts");
    expect((await readRequest(inB.requestId)).stage).toBe("awaiting_invoice");

    expect((await account(accountantDeptA.id, bill.requestId, v.id, { declineOpenAdvance: { reason: "Different job" } })).ok).toBe(true);
  });
});

// ---- attach: one payable request, not two -----------------------------

describe("attaching a bill to the open advance", () => {
  it("moves the invoice onto the advance, closes the new request unpaid, and leaves exactly one thing to pay", { timeout: HEAVY_TEST_TIMEOUT }, async () => {
    const v = await makeVendor("attach");
    const advance = await makeOpenAdvance(v);
    const bill = await billAtAccounts({ amountMinor: 900_000 });
    const billRow = await readRequest(bill.requestId);
    const billFiles = await dbOwner.select().from(requestFile).where(eq(requestFile.requestId, bill.requestId));

    const attached = await attachToOpenAdvance(accountant.id, bill.requestId, { advanceRequestId: advance.requestId, vendorId: v.id }, META);
    expect(attached.ok).toBe(true);

    // The advance carries the invoice and is back with the payer for the balance.
    const adv = await readRequest(advance.requestId);
    expect(adv.stage).toBe("to_pay");
    expect(adv.invoiceNo).toBe(billRow.invoiceNo);
    expect(adv.invoiceDate).toBe("2026-10-01");
    expect(adv.amountMinor).toBe(900_000);
    expect(adv.invoiceAttachedAt).not.toBeNull();
    expect(adv.payNowMinor).toBe(ADVANCE_PAID);
    const advFiles = await dbOwner.select().from(requestFile).where(eq(requestFile.requestId, advance.requestId));
    expect(advFiles.map((f) => f.sha256)).toContain(billFiles[0].sha256);

    // The bill is closed, unpaid, and points at where it went. Withdrawn, not
    // rejected: rejected requests stay in the duplicate index forever.
    const closed = await readRequest(bill.requestId);
    expect(closed.stage).toBe("withdrawn");
    expect(closed.linkedRequest).toBe(advance.requestId);
    expect(closed.closeReason).toContain(advance.ref);
    expect(await dbOwner.$count(payment, eq(payment.requestId, bill.requestId))).toBe(0);

    // Both trails say so, and both chains are intact.
    const advEvents = await eventsOf(advance.requestId);
    const last = advEvents[advEvents.length - 1];
    expect(last.type).toBe("request.invoice_attached");
    expect(last.roleAtTime).toBe("accountant");
    expect((last.after as { viaRef: string }).viaRef).toBe(bill.ref);
    const billEvents = await eventsOf(bill.requestId);
    expect(billEvents[billEvents.length - 1].type).toBe("request.attached_to_advance");
    expect((billEvents[billEvents.length - 1].after as { advanceRef: string }).advanceRef).toBe(advance.ref);
    await assertChainIntact(advance.requestId);
    await assertChainIntact(bill.requestId);

    // Recorded as an attach: a verdict row with nobody having declined.
    const rows = await verdictRows(bill.requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ verdict: "matched_advance", matchedRequestId: advance.requestId, overriddenBy: null });
    expect(rows[0].signals).toContain("attached");

    // The advance is no longer open, and the closed bill cannot be paid.
    expect(await checkOpenAdvances(accountant.id, "accountant", { vendorKey: v.gstin })).toEqual([]);
    expect((await pay(bill.requestId, 900_000)).ok).toBe(false);

    // The balance is the invoice less the advance, paid once, on the advance.
    expect((await pay(advance.requestId, 500_001)).ok).toBe(false);
    expect((await pay(advance.requestId, 500_000)).ok).toBe(true);
    expect((await readRequest(advance.requestId)).stage).toBe("paid");
    expect(await dbOwner.$count(payment, inArray(payment.requestId, [advance.requestId, bill.requestId]))).toBe(2);

    // The invoice is consumed: the same bill raised again is the ordinary
    // paid-duplicate hard block, from the same index every invoice uses.
    const again = await billAtAccounts({ invoiceNo: billRow.invoiceNo!, invoiceDate: "2026-10-01" });
    const blocked = await account(accountant.id, again.requestId, v.id);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.duplicate?.verdict).toBe("blocked_paid");
      expect(blocked.error).toContain("already paid");
    }
  });

  it("refuses an invoice below what the advance already paid, and changes nothing", { timeout: HEAVY_TEST_TIMEOUT }, async () => {
    const v = await makeVendor("below");
    const advance = await makeOpenAdvance(v);
    const bill = await billAtAccounts({ amountMinor: 300_000 });
    const filesBefore = await dbOwner.$count(requestFile, eq(requestFile.requestId, advance.requestId));

    const attempt = await attachToOpenAdvance(accountant.id, bill.requestId, { advanceRequestId: advance.requestId, vendorId: v.id }, META);
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error).toContain("already paid");

    const adv = await readRequest(advance.requestId);
    expect(adv.stage).toBe("awaiting_invoice");
    expect(adv.invoiceAttachedAt).toBeNull();
    expect(adv.amountMinor).toBe(QUOTED);
    expect((await readRequest(bill.requestId)).stage).toBe("with_accounts");
    expect(await dbOwner.$count(requestFile, eq(requestFile.requestId, advance.requestId))).toBe(filesBefore);
    expect(await verdictRows(bill.requestId)).toHaveLength(0);
  });

  it("only attaches to an advance paid to the vendor the accountant selected, and only a bill to an advance", { timeout: HEAVY_TEST_TIMEOUT }, async () => {
    const v = await makeVendor("owner");
    const other = await makeVendor("stranger");
    const advance = await makeOpenAdvance(v);
    const bill = await billAtAccounts();

    // Otherwise this would be a way to hang any invoice on any advance.
    const wrongVendor = await attachToOpenAdvance(accountant.id, bill.requestId, { advanceRequestId: advance.requestId, vendorId: other.id }, META);
    expect(wrongVendor.ok).toBe(false);
    if (!wrongVendor.ok) expect(wrongVendor.error).toContain("different vendor");

    // An advance is not a bill; attaching one to another advance is nonsense.
    const anotherAdvance = await raiseOk({ kind: "advance", amountMinor: QUOTED, payNowMinor: ADVANCE_PAID, quotationNo: "QT-X" });
    await approve(anotherAdvance.requestId);
    const notABill = await attachToOpenAdvance(accountant.id, anotherAdvance.requestId, { advanceRequestId: advance.requestId, vendorId: v.id }, META);
    expect(notABill.ok).toBe(false);

    expect((await readRequest(advance.requestId)).stage).toBe("awaiting_invoice");
    expect((await readRequest(bill.requestId)).stage).toBe("with_accounts");
  });

  it("needs an invoice number and date from somewhere, since the number is what stops it being paid twice", { timeout: HEAVY_TEST_TIMEOUT }, async () => {
    const v = await makeVendor("nonumber");
    const advance = await makeOpenAdvance(v);
    const bill = await raiseOk({ amountMinor: 900_000 });
    await approve(bill.requestId);

    const missing = await attachToOpenAdvance(accountant.id, bill.requestId, { advanceRequestId: advance.requestId, vendorId: v.id }, META);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("invoice number");

    const supplied = await attachToOpenAdvance(
      accountant.id,
      bill.requestId,
      { advanceRequestId: advance.requestId, vendorId: v.id, invoiceNo: "SUPPLIED/25-26/0912", invoiceDate: "2026-10-05" },
      META,
    );
    expect(supplied.ok).toBe(true);
    const adv = await readRequest(advance.requestId);
    expect(adv.invoiceNo).toBe("SUPPLIED/25-26/0912");
    expect(adv.invoiceKey).toBe("SUPPLIED/25-26/0912");
  });

  it("refuses an invoice that was already paid on another request", { timeout: HEAVY_TEST_TIMEOUT }, async () => {
    const v = await makeVendor("consumed");
    const invoiceNo = `PAID-${randomUUID().slice(0, 6)}`.toUpperCase();
    // The bill was already paid, in full, on an ordinary request.
    const earlier = await billAtAccounts({ invoiceNo, invoiceDate: "2026-10-01" });
    const booked = await account(accountant.id, earlier.requestId, v.id);
    if (!booked.ok) throw new Error(booked.error);
    const paidInFull = await pay(earlier.requestId, 900_000);
    if (!paidInFull.ok) throw new Error(paidInFull.error);

    // Only now does the vendor get an advance and a bill with the same number.
    const advance = await makeOpenAdvance(v);
    const dupe = await billAtAccounts({ invoiceNo, invoiceDate: "2026-10-01" });
    const attempt = await attachToOpenAdvance(accountant.id, dupe.requestId, { advanceRequestId: advance.requestId, vendorId: v.id }, META);
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.duplicate?.verdict).toBe("blocked_paid");
    expect((await readRequest(advance.requestId)).stage).toBe("awaiting_invoice");
    expect((await readRequest(dupe.requestId)).stage).toBe("with_accounts");
  });

  it("two bills raced at the same advance: exactly one lands, the other is left untouched", { timeout: HEAVY_TEST_TIMEOUT }, async () => {
    const v = await makeVendor("race");
    const advance = await makeOpenAdvance(v);
    const one = await billAtAccounts({ amountMinor: 900_000 });
    const two = await billAtAccounts({ amountMinor: 900_000 });

    const results = await Promise.all([
      attachToOpenAdvance(accountant.id, one.requestId, { advanceRequestId: advance.requestId, vendorId: v.id }, META),
      attachToOpenAdvance(accountant.id, two.requestId, { advanceRequestId: advance.requestId, vendorId: v.id }, META),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);

    const stages = [(await readRequest(one.requestId)).stage, (await readRequest(two.requestId)).stage].sort();
    expect(stages).toEqual(["with_accounts", "withdrawn"]);
    const invoiceEvents = (await eventsOf(advance.requestId)).filter((e) => e.type === "request.invoice_attached");
    expect(invoiceEvents).toHaveLength(1);
    await assertChainIntact(advance.requestId);
  });
});

// ---- the structural guarantees this change must not touch -------------

describe("the database-level guarantees are untouched", () => {
  it("one_payment_per_invoice and the payment reference index are still there, with their original definitions", async () => {
    const rows = await dbOwner.execute<{ indexname: string; indexdef: string }>(
      sql`select indexname, indexdef from pg_indexes where indexname in ('one_payment_per_invoice', 'payment_reference_unique_idx') order by indexname`,
    );
    const defs = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
    expect(Object.keys(defs)).toEqual(["one_payment_per_invoice", "payment_reference_unique_idx"]);
    expect(defs.one_payment_per_invoice).toMatch(/UNIQUE/i);
    expect(defs.one_payment_per_invoice).toMatch(/vendor_key, invoice_key, fy/);
    expect(defs.one_payment_per_invoice).toMatch(/stage = 'paid'/);
    expect(defs.payment_reference_unique_idx).toMatch(/UNIQUE/i);
    expect(defs.payment_reference_unique_idx).toMatch(/upper/i);
  });

  it("clicking through every warning still cannot pay one invoice twice: the second payment hits the index", { timeout: HEAVY_TEST_TIMEOUT }, async () => {
    const v = await makeVendor("index");
    const advance = await makeOpenAdvance(v);
    const invoiceNo = `IDX-${randomUUID().slice(0, 6)}`.toUpperCase();

    // The dangerous case, done the wrong way on purpose: the invoice is raised
    // as a fresh request, the offer to attach is declined, and it is paid in
    // full — all of which the application allows, because declining is
    // permitted and recorded.
    const fresh = await billAtAccounts({ invoiceNo, invoiceDate: "2026-10-01" });
    expect((await account(accountant.id, fresh.requestId, v.id, { declineOpenAdvance: { reason: "clicked through" } })).ok).toBe(true);
    expect((await pay(fresh.requestId, 900_000)).ok).toBe(true);

    // The advance's own request is then handed the same invoice by the
    // requester (the path the brief warns about). Paying its balance is where
    // the database says no, whatever anyone clicked earlier.
    await dbOwner
      .update(request)
      .set({ stage: "to_pay", invoiceNo, invoiceDate: "2026-10-01", amountMinor: 900_000, invoiceAttachedAt: new Date() })
      .where(eq(request.id, advance.requestId));
    const second = await pay(advance.requestId, 500_000);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain("already paid");
    expect(await dbOwner.$count(payment, eq(payment.requestId, advance.requestId))).toBe(1);
  });
});
