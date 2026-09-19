import { randomUUID } from "node:crypto";
import { eq, inArray, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeOwnerConnection, dbOwner } from "../scripts/db-owner";
import { withGrantScope } from "../src/db/runtime";
import { accounting, company, department, duplicateCheck, event, headOfAccount, request, requestFile, roleGrant, user, vendor } from "../src/db/schema";
import { hashSecret } from "../src/auth/password";
import { submitRequest, type Attachment } from "../src/requests/captureCore";
import { accountRequest, approveRequest } from "../src/requests/transitions";
import { presignPutUrl } from "../src/storage/r2";
import { buildStorageKey } from "../src/storage/storageKey";
import { decryptSecret, encryptSecret } from "../src/vendors/crypto";
import { createVendor, searchVendors } from "../src/vendors/vendorsCore";

// The phase-9 gate. Same philosophy as tests/{desks,comments,queries,
// nudges}.test.ts: exercises the real vendorsCore.ts/transitions.ts
// against the real dev Supabase project, no mocks. Explicitly browser-only,
// NOT attempted here: AccountantPanel's inline search/create UI, the
// vendor manage page's cards and forms.

const nonce = randomUUID().slice(0, 8);
const META = { ip: "203.0.113.31", userAgent: "vitest" };

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
    .values({ name: `Vendors Test ${label} ${nonce}`, email: `vendors-test-${label}-${nonce}@example.invalid`, passwordHash: await hashSecret("unused") })
    .returning({ id: user.id });
  return u;
}

async function raiseTestRequest(): Promise<string> {
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

beforeAll(async () => {
  [deptA] = await dbOwner.insert(department).values({ name: `Vendors Test Dept A ${nonce}`, code: `VND-A-${nonce}`, ageingThresholdDays: 30 }).returning({ id: department.id });
  [companyX] = await dbOwner.insert(company).values({ name: `Vendors Test Co X ${nonce}`, legalName: `Vendors Test Co X ${nonce} Pvt Ltd` }).returning({ id: company.id });
  [head] = await dbOwner.insert(headOfAccount).values({ name: `Vendors Test Head ${nonce}`, code: `VND-H-${nonce}` }).returning({ id: headOfAccount.id });

  requesterUser = await makeUser("requester");
  approverUser = await makeUser("approver");
  accountantUser = await makeUser("accountant");

  await grant(requesterUser.id, "requester", { deptIds: [deptA.id] });
  await grant(approverUser.id, "approver", { deptIds: [deptA.id] });
  await grant(accountantUser.id, "accountant", { companyIds: [companyX.id] });
});

afterAll(async () => {
  const userIds = [requesterUser.id, approverUser.id, accountantUser.id];

  const reqs = await dbOwner.select({ id: request.id }).from(request).where(eq(request.departmentId, deptA.id));
  const reqIds = reqs.map((r) => r.id);
  if (reqIds.length > 0) {
    await dbOwner.delete(accounting).where(inArray(accounting.requestId, reqIds));
    await dbOwner.delete(event).where(inArray(event.requestId, reqIds));
    await dbOwner.delete(requestFile).where(inArray(requestFile.requestId, reqIds));
    // A submit that surfaces a match records a duplicate_check row, and
    // BOTH of its columns are foreign keys to request — request_id for
    // this submission, matched_request_id for the older one it matched.
    // Either side pointing at a fixture request blocks the delete below,
    // so both are cleared.
    await dbOwner
      .delete(duplicateCheck)
      .where(or(inArray(duplicateCheck.requestId, reqIds), inArray(duplicateCheck.matchedRequestId, reqIds)));
    await dbOwner.delete(request).where(inArray(request.id, reqIds));
  }
  await dbOwner.delete(roleGrant).where(inArray(roleGrant.userId, userIds));
  if (createdVendorIds.length > 0) {
    await dbOwner.delete(vendor).where(inArray(vendor.id, createdVendorIds));
  }
  await dbOwner.delete(headOfAccount).where(eq(headOfAccount.id, head.id));
  await dbOwner.delete(department).where(eq(department.id, deptA.id));
  await dbOwner.delete(company).where(eq(company.id, companyX.id));
  await dbOwner.delete(user).where(inArray(user.id, userIds));
  await closeOwnerConnection();
});

describe("vendor master (the phase-9 gate)", () => {
  it("encryptSecret/decryptSecret round-trip", () => {
    const plaintext = "000123456789";
    const encoded = encryptSecret(plaintext);
    expect(encoded).not.toContain(plaintext);
    expect(decryptSecret(encoded)).toBe(plaintext);
  });

  it("createVendor then searchVendors finds it by name and by GSTIN", async () => {
    const requestId = await raiseTestRequest();
    const gstin = `GSTIN-${nonce}-1`.toUpperCase();
    const result = await createVendor(accountantUser.id, "accountant", requestId, { name: `Vendors Test Krishna ${nonce}`, gstin }, META);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdVendorIds.push(result.id);

    const byName = await searchVendors(accountantUser.id, "accountant", `Vendors Test Krishna ${nonce}`);
    expect(byName.map((v) => v.id)).toContain(result.id);

    const byGstin = await searchVendors(accountantUser.id, "accountant", gstin);
    expect(byGstin.map((v) => v.id)).toContain(result.id);
  });

  it("accountRequest refuses to complete without a vendor", async () => {
    const requestId = await raiseTestRequest();
    const approveResult = await approveRequest(approverUser.id, requestId, { cycle: "immediate", dueDate: null, noteToAccountsAndPayer: null }, META);
    expect(approveResult.ok).toBe(true);

    const result = await accountRequest(
      accountantUser.id,
      requestId,
      // @ts-expect-error — vendorId intentionally omitted to prove the server-side guard, not just the type
      { companyId: companyX.id, headId: head.id, voucherNo: `PV-${nonce}-novendor`, bookedOn: "2026-08-20" },
      META,
    );
    expect(result.ok).toBe(false);
  });

  it("accountRequest writes request.vendorKey from the matched vendor's own generated key", async () => {
    const requestId = await raiseTestRequest();
    const gstin = `GSTIN-${nonce}-2`.toUpperCase();
    const created = await createVendor(accountantUser.id, "accountant", requestId, { name: `Vendors Test Bharat ${nonce}`, gstin }, META);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    createdVendorIds.push(created.id);

    const approveResult = await approveRequest(approverUser.id, requestId, { cycle: "immediate", dueDate: null, noteToAccountsAndPayer: null }, META);
    expect(approveResult.ok).toBe(true);

    const result = await accountRequest(
      accountantUser.id,
      requestId,
      { companyId: companyX.id, vendorId: created.id, headId: head.id, voucherNo: `PV-${nonce}-vk`, bookedOn: "2026-08-20" },
      META,
    );
    expect(result.ok).toBe(true);

    const [row] = await withGrantScope(accountantUser.id, "accountant", (tx) => tx.select({ vendorKey: request.vendorKey }).from(request).where(eq(request.id, requestId)));
    expect(row.vendorKey).toBe(gstin);
  });

  it("two accountants racing to create the same-GSTIN vendor: exactly one succeeds", async () => {
    const gstin = `GSTIN-${nonce}-3`.toUpperCase();
    const [reqA, reqB] = await Promise.all([raiseTestRequest(), raiseTestRequest()]);

    const [resultA, resultB] = await Promise.all([
      createVendor(accountantUser.id, "accountant", reqA, { name: `Vendors Test Race A ${nonce}`, gstin }, META),
      createVendor(accountantUser.id, "accountant", reqB, { name: `Vendors Test Race B ${nonce}`, gstin }, META),
    ]);

    const outcomes = [resultA, resultB];
    const succeeded = outcomes.filter((r) => r.ok);
    const failed = outcomes.filter((r) => !r.ok);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    if (!failed[0].ok) {
      expect(failed[0].error).toMatch(/already exists/i);
    }
    if (succeeded[0].ok) {
      createdVendorIds.push(succeeded[0].id);
    }
  });

  it("an out-of-role actor (requester) gets no vendor rows under RLS", async () => {
    const rows = await withGrantScope(requesterUser.id, "requester", (tx) => tx.select().from(vendor));
    expect(rows).toEqual([]);
  });

  it("an approver (not in vendor_select's role list) also gets no vendor rows under RLS", async () => {
    const rows = await withGrantScope(approverUser.id, "approver", (tx) => tx.select().from(vendor));
    expect(rows).toEqual([]);
  });
});
