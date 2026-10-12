import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeOwnerConnection, dbOwner } from "../scripts/db-owner";
import { hashSecret } from "../src/auth/password";
import { department, event, request, requestFile, roleGrant, user, vendor, vendorBank } from "../src/db/schema";
import { submitRequest, type Attachment } from "../src/requests/captureCore";
import { approveRequest } from "../src/requests/transitions";
import { presignPutUrl } from "../src/storage/r2";
import { buildStorageKey } from "../src/storage/storageKey";
import { addVendorBankForRequest, createVendor, searchVendors } from "../src/vendors/vendorsCore";

// Bank details captured at the accounts desk: at vendor creation, or for a
// vendor that has none, or to replace the one on file. The real vendorsCore
// against the real dev project, no mocks.

const nonce = randomUUID().slice(0, 8);
const META = { ip: "203.0.113.50", userAgent: "vitest" };
const BANK = { beneficiaryName: "Bank Test Traders", accountNumber: "000111222333", ifsc: "test0000001", branch: "Main", effectiveFrom: "2026-10-11" };

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

let dept: { id: string };
let requesterUser: { id: string };
let accountantUser: { id: string };
let approverUser: { id: string };
let requestId: string;

async function makeUser(label: string) {
  const [u] = await dbOwner
    .insert(user)
    .values({ name: `AcctBank Test ${label} ${nonce}`, email: `acctbank-test-${label}-${nonce}@example.invalid`, passwordHash: await hashSecret("unused") })
    .returning({ id: user.id });
  return u;
}

async function currentBanks(vendorId: string) {
  return dbOwner.select().from(vendorBank).where(and(eq(vendorBank.vendorId, vendorId), isNull(vendorBank.supersededAt)));
}

beforeAll(async () => {
  [dept] = await dbOwner.insert(department).values({ name: `AcctBank Test Dept ${nonce}`, code: `ABK-${nonce}`, ageingThresholdDays: 30 }).returning({ id: department.id });
  requesterUser = await makeUser("requester");
  accountantUser = await makeUser("accountant");
  approverUser = await makeUser("approver");
  await dbOwner.insert(roleGrant).values({ userId: requesterUser.id, role: "requester", deptScope: "list", departmentIds: [dept.id], companyScope: "n/a", grantedBy: requesterUser.id });
  await dbOwner.insert(roleGrant).values({ userId: approverUser.id, role: "approver", deptScope: "list", departmentIds: [dept.id], companyScope: "n/a", grantedBy: approverUser.id });
  await dbOwner.insert(roleGrant).values({ userId: accountantUser.id, role: "accountant", deptScope: "list", departmentIds: [dept.id], companyScope: "global", grantedBy: accountantUser.id });

  const file = await uploadTestFile();
  const result = await submitRequest({ userId: requesterUser.id, ip: META.ip, userAgent: META.userAgent, departmentId: dept.id, amountMinor: 50000, attachments: [file] });
  if (!result.ok) throw new Error(result.error);
  requestId = result.requestId;
});

afterAll(async () => {
  const vendors = await dbOwner.select({ id: vendor.id }).from(vendor).where(inArray(vendor.createdBy, [accountantUser.id]));
  const vendorIds = vendors.map((v) => v.id);
  if (vendorIds.length > 0) {
    await dbOwner.delete(vendorBank).where(inArray(vendorBank.vendorId, vendorIds));
  }
  const noteReqs = await dbOwner.select({ id: request.id }).from(request).where(eq(request.departmentId, dept.id));
  const allReqIds = noteReqs.map((r) => r.id);
  await dbOwner.delete(event).where(inArray(event.requestId, allReqIds));
  await dbOwner.delete(requestFile).where(inArray(requestFile.requestId, allReqIds));
  await dbOwner.delete(request).where(inArray(request.id, allReqIds));
  if (vendorIds.length > 0) await dbOwner.delete(vendor).where(inArray(vendor.id, vendorIds));
  await dbOwner.delete(roleGrant).where(inArray(roleGrant.userId, [requesterUser.id, accountantUser.id, approverUser.id]));
  await dbOwner.delete(department).where(eq(department.id, dept.id));
  await dbOwner.delete(user).where(inArray(user.id, [requesterUser.id, accountantUser.id, approverUser.id]));
  await closeOwnerConnection();
});

describe("bank details at the accounts desk", () => {
  it("captures the bank when the vendor is created, unverified, and shows it in search and the trail", async () => {
    const name = `AcctBank Vendor Created ${nonce}`;
    const created = await createVendor(accountantUser.id, "accountant", requestId, { name, bank: BANK }, META);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const [bank] = await currentBanks(created.id);
    expect(bank.beneficiaryName).toBe("Bank Test Traders");
    expect(bank.accountNumberLast4).toBe("2333");
    expect(bank.ifsc).toBe("TEST0000001");
    expect(bank.verifiedAt).toBeNull();
    expect(bank.enteredBy).toBe(accountantUser.id);
    // The full account number is encrypted, never stored in the clear.
    expect(bank.accountNumberEncrypted).not.toContain("000111222333");

    const [found] = await searchVendors(accountantUser.id, "accountant", name);
    expect(found.bank).toEqual({ beneficiaryName: "Bank Test Traders", accountNumberLast4: "2333", ifsc: "TEST0000001", branch: "Main", verified: false });
    // One event carries the bank, not two: see the comment in createVendor.
    const created_ = await dbOwner.select().from(event).where(and(eq(event.requestId, requestId), eq(event.objectId, created.id)));
    expect(created_).toHaveLength(1);
    expect((created_[0].after as { bank?: { accountNumberLast4?: string } }).bank?.accountNumberLast4).toBe("2333");
  });

  it("keeps the request's hash chain unforked across a vendor created with a bank and the events after it", async () => {
    const created = await createVendor(accountantUser.id, "accountant", requestId, { name: `AcctBank Vendor Chain ${nonce}`, bank: BANK }, META);
    if (!created.ok) throw new Error(created.error);
    expect(await addVendorBankForRequest(accountantUser.id, requestId, created.id, { ...BANK, accountNumber: "555566667777" }, META)).toEqual({ ok: true });

    const events = await dbOwner.select({ hash: event.hash, prevHash: event.prevHash }).from(event).where(eq(event.requestId, requestId));
    const prevHashes = events.map((e) => e.prevHash).filter((h): h is string => h !== null);
    // Every link has exactly one successor: no two events share a predecessor.
    expect(new Set(prevHashes).size).toBe(prevHashes.length);
  });

  it("a bad bank record at creation creates no vendor at all", async () => {
    const name = `AcctBank Vendor Rejected ${nonce}`;
    const result = await createVendor(accountantUser.id, "accountant", requestId, { name, bank: { ...BANK, accountNumber: "12" } }, META);
    expect(result.ok).toBe(false);
    expect(await searchVendors(accountantUser.id, "accountant", name)).toHaveLength(0);
  });

  it("a vendor created without a bank shows none, and the bank can be added for the request", async () => {
    const name = `AcctBank Vendor Later ${nonce}`;
    const created = await createVendor(accountantUser.id, "accountant", requestId, { name }, META);
    if (!created.ok) throw new Error(created.error);

    const [before] = await searchVendors(accountantUser.id, "accountant", name);
    expect(before.bank).toBeNull();

    expect(await addVendorBankForRequest(accountantUser.id, requestId, created.id, BANK, META)).toEqual({ ok: true });
    const [after] = await searchVendors(accountantUser.id, "accountant", name);
    expect(after.bank?.accountNumberLast4).toBe("2333");
    expect(after.bank?.verified).toBe(false);
  });

  it("replacing the bank supersedes the old record, leaving exactly one current and unverified", async () => {
    const created = await createVendor(accountantUser.id, "accountant", requestId, { name: `AcctBank Vendor Replace ${nonce}`, bank: BANK }, META);
    if (!created.ok) throw new Error(created.error);
    const [first] = await currentBanks(created.id);
    // Pretend the payer had verified the first record.
    await dbOwner.update(vendorBank).set({ verifiedAt: new Date(), verifiedBy: accountantUser.id }).where(eq(vendorBank.id, first.id));

    const replaced = await addVendorBankForRequest(accountantUser.id, requestId, created.id, { ...BANK, accountNumber: "999888777666", ifsc: "TEST0000002" }, META);
    expect(replaced).toEqual({ ok: true });

    const current = await currentBanks(created.id);
    expect(current).toHaveLength(1);
    expect(current[0].accountNumberLast4).toBe("7666");
    expect(current[0].verifiedAt).toBeNull();
    const [old] = await dbOwner.select().from(vendorBank).where(eq(vendorBank.id, first.id));
    expect(old.supersededAt).not.toBeNull();
  });

  it("refuses a missing beneficiary, a bad account number, a missing IFSC, and an unknown request", async () => {
    const created = await createVendor(accountantUser.id, "accountant", requestId, { name: `AcctBank Vendor Validate ${nonce}` }, META);
    if (!created.ok) throw new Error(created.error);

    expect((await addVendorBankForRequest(accountantUser.id, requestId, created.id, { ...BANK, beneficiaryName: " " }, META)).ok).toBe(false);
    expect((await addVendorBankForRequest(accountantUser.id, requestId, created.id, { ...BANK, accountNumber: "12ab" }, META)).ok).toBe(false);
    expect((await addVendorBankForRequest(accountantUser.id, requestId, created.id, { ...BANK, ifsc: "" }, META)).ok).toBe(false);
    expect((await addVendorBankForRequest(accountantUser.id, randomUUID(), created.id, BANK, META)).ok).toBe(false);
    expect(await currentBanks(created.id)).toHaveLength(0);
  });
});

describe("approval and the requester's note", () => {
  it("approving keeps the requester's note, and the approver's note goes in the trail", async () => {
    const file = await uploadTestFile();
    const raised = await submitRequest({ userId: requesterUser.id, ip: META.ip, userAgent: META.userAgent, departmentId: dept.id, amountMinor: 70000, note: "Goods received on the 9th.", attachments: [file] });
    if (!raised.ok) throw new Error(raised.error);

    const approved = await approveRequest(approverUser.id, raised.requestId, { cycle: "immediate", dueDate: null, noteToAccountsAndPayer: "Rates match the contract." }, META);
    expect(approved).toEqual({ ok: true });

    const [row] = await dbOwner.select().from(request).where(eq(request.id, raised.requestId));
    expect(row.note).toBe("Goods received on the 9th.");
    const [approvedEvent] = await dbOwner.select().from(event).where(and(eq(event.requestId, raised.requestId), eq(event.type, "request.approved")));
    expect((approvedEvent.after as { noteToAccountsAndPayer?: string }).noteToAccountsAndPayer).toBe("Rates match the contract.");
  });

  it("an approval with no note of its own leaves the requester's note intact", async () => {
    const file = await uploadTestFile();
    const raised = await submitRequest({ userId: requesterUser.id, ip: META.ip, userAgent: META.userAgent, departmentId: dept.id, amountMinor: 71000, note: "Urgent, vendor chasing.", attachments: [file] });
    if (!raised.ok) throw new Error(raised.error);
    await approveRequest(approverUser.id, raised.requestId, { cycle: "unspecified", dueDate: null, noteToAccountsAndPayer: null }, META);
    const [row] = await dbOwner.select().from(request).where(eq(request.id, raised.requestId));
    expect(row.note).toBe("Urgent, vendor chasing.");
  });
});
