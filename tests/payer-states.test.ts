import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeOwnerConnection, dbOwner } from "../scripts/db-owner";
import { hashSecret } from "../src/auth/password";
import { raiseQuery } from "../src/conversation/queriesCore";
import { withGrantScope } from "../src/db/runtime";
import { department, event, query, request, requestFile, requestFlag, roleGrant, user } from "../src/db/schema";
import { computeFlags, loadFlagContext, type FlagContext } from "../src/flags/computeFlags";
import { clearManualFlag, clearPaymentInProgress, holdAsPayer, markPaymentInProgress, raiseManualFlag, releasePayerHold } from "../src/requests/payerStates";
import { submitRequest, type Attachment } from "../src/requests/captureCore";
import { returnToAccounts } from "../src/requests/transitions";
import { presignPutUrl } from "../src/storage/r2";
import { buildStorageKey } from "../src/storage/storageKey";

// The payer's working states (in progress / on hold) and manual flags. Same
// philosophy as tests/nudges.test.ts: the real modules against the real dev
// project, no mocks. A request is put in to_pay directly through the owner
// connection rather than walked through accounting, because nothing here
// depends on how it got there. Not covered: payRequest clearing the state
// (it needs a verified vendor bank; the CHECK in 0026 is what guarantees it).

const nonce = randomUUID().slice(0, 8);
const META = { ip: "203.0.113.40", userAgent: "vitest" };

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
let requesterUser: { id: string };
let approverUser: { id: string };
let payerUser: { id: string };
let payerUserB: { id: string }; // deptB, out of scope

async function makeUser(label: string) {
  const [u] = await dbOwner
    .insert(user)
    .values({ name: `PayerStates Test ${label} ${nonce}`, email: `payerstates-test-${label}-${nonce}@example.invalid`, passwordHash: await hashSecret("unused") })
    .returning({ id: user.id });
  return u;
}

async function grant(userId: string, role: string, deptIds: string[], companyScope: "n/a" | "global" = "n/a") {
  await dbOwner.insert(roleGrant).values({
    userId,
    role: role as (typeof roleGrant.$inferInsert)["role"],
    deptScope: "list",
    departmentIds: deptIds,
    companyScope,
    grantedBy: userId,
  });
}

async function requestInToPay(): Promise<string> {
  const file = await uploadTestFile();
  const result = await submitRequest({ userId: requesterUser.id, ip: META.ip, userAgent: META.userAgent, departmentId: deptA.id, amountMinor: 50000, attachments: [file] });
  if (!result.ok) throw new Error(result.error);
  await dbOwner.update(request).set({ stage: "to_pay" }).where(eq(request.id, result.requestId));
  return result.requestId;
}

async function stateOf(requestId: string) {
  const [r] = await dbOwner.select().from(request).where(eq(request.id, requestId));
  return r;
}

async function eventTypes(requestId: string) {
  const rows = await dbOwner.select({ type: event.type }).from(event).where(eq(event.requestId, requestId));
  return rows.map((r) => r.type);
}

beforeAll(async () => {
  [deptA] = await dbOwner.insert(department).values({ name: `PayerStates Test Dept A ${nonce}`, code: `PST-A-${nonce}`, ageingThresholdDays: 30 }).returning({ id: department.id });
  [deptB] = await dbOwner.insert(department).values({ name: `PayerStates Test Dept B ${nonce}`, code: `PST-B-${nonce}`, ageingThresholdDays: 30 }).returning({ id: department.id });
  requesterUser = await makeUser("requester");
  approverUser = await makeUser("approver");
  payerUser = await makeUser("payer");
  payerUserB = await makeUser("payer-b");
  await grant(requesterUser.id, "requester", [deptA.id]);
  await grant(approverUser.id, "approver", [deptA.id]);
  await grant(payerUser.id, "payer", [deptA.id], "global");
  await grant(payerUserB.id, "payer", [deptB.id], "global");
});

afterAll(async () => {
  const userIds = [requesterUser.id, approverUser.id, payerUser.id, payerUserB.id];
  const reqs = await dbOwner.select({ id: request.id }).from(request).where(inArray(request.departmentId, [deptA.id, deptB.id]));
  const reqIds = reqs.map((r) => r.id);
  if (reqIds.length > 0) {
    await dbOwner.delete(requestFlag).where(inArray(requestFlag.requestId, reqIds));
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

describe("payer states", () => {
  it("marks a payment in progress, refuses a second mark and a return to accounts, then clears", async () => {
    const id = await requestInToPay();

    expect(await markPaymentInProgress(payerUser.id, id, { note: "bank batch 3 pm" }, META)).toEqual({ ok: true });
    const r = await stateOf(id);
    expect(r.payerState).toBe("in_progress");
    expect(r.payerStateReason).toBe("bank batch 3 pm");
    expect(r.payerStateBy).toBe(payerUser.id);
    expect(r.stage).toBe("to_pay");

    const again = await markPaymentInProgress(payerUser.id, id, {}, META);
    expect(again.ok).toBe(false);

    const back = await returnToAccounts(payerUser.id, id, { reason: "wrong head" }, META);
    expect(back.ok).toBe(false);
    if (!back.ok) expect(back.error).toMatch(/in progress/i);
    expect((await stateOf(id)).stage).toBe("to_pay");

    expect(await clearPaymentInProgress(payerUser.id, id, META)).toEqual({ ok: true });
    expect((await stateOf(id)).payerState).toBeNull();
    expect(await eventTypes(id)).toEqual(expect.arrayContaining(["request.payment_in_progress", "request.payment_in_progress_cleared"]));
  });

  it("a payer hold needs a reason and a review date, and can be released", async () => {
    const id = await requestInToPay();

    expect((await holdAsPayer(payerUser.id, id, { reason: "  ", reviewOn: "2026-11-01" }, META)).ok).toBe(false);
    expect((await holdAsPayer(payerUser.id, id, { reason: "insufficient funds", reviewOn: "" }, META)).ok).toBe(false);

    expect(await holdAsPayer(payerUser.id, id, { reason: "insufficient funds", reviewOn: "2026-11-01" }, META)).toEqual({ ok: true });
    const held = await stateOf(id);
    expect(held.payerState).toBe("on_hold");
    expect(held.payerReviewOn).toBe("2026-11-01");

    // Held and in-progress are mutually exclusive.
    expect((await markPaymentInProgress(payerUser.id, id, {}, META)).ok).toBe(false);

    expect(await releasePayerHold(payerUser.id, id, META)).toEqual({ ok: true });
    const released = await stateOf(id);
    expect(released.payerState).toBeNull();
    expect(released.payerReviewOn).toBeNull();
    expect(await eventTypes(id)).toEqual(expect.arrayContaining(["request.payer_held", "request.payer_hold_released"]));
  });

  it("returning a held request to accounts clears the hold in the same update", async () => {
    const id = await requestInToPay();
    await holdAsPayer(payerUser.id, id, { reason: "vendor account frozen", reviewOn: "2026-11-05" }, META);

    const back = await returnToAccounts(payerUser.id, id, { reason: "needs a different vendor record" }, META);
    expect(back).toEqual({ ok: true });
    const r = await stateOf(id);
    expect(r.stage).toBe("with_accounts");
    expect(r.payerState).toBeNull();
    expect(r.payerStateBy).toBeNull();
  });

  it("an open query freezes the payer's working state like it freezes every transition", async () => {
    const id = await requestInToPay();
    const q = await raiseQuery(approverUser.id, id, { directedAt: ["requester"], question: "Was this goods or service?" }, META);
    expect(q.ok).toBe(true);

    const mark = await markPaymentInProgress(payerUser.id, id, {}, META);
    expect(mark.ok).toBe(false);
    if (!mark.ok) expect(mark.error).toMatch(/open query/i);
    expect((await holdAsPayer(payerUser.id, id, { reason: "x", reviewOn: "2026-11-01" }, META)).ok).toBe(false);
  });

  it("a payer outside the department cannot touch the request", async () => {
    const id = await requestInToPay();
    const result = await markPaymentInProgress(payerUserB.id, id, {}, META);
    expect(result.ok).toBe(false);
    expect((await stateOf(id)).payerState).toBeNull();
  });

  it("only the payer role can set a payer state", async () => {
    const id = await requestInToPay();
    // The approver holds no payer grant: withGrantScope refuses outright.
    await expect(markPaymentInProgress(approverUser.id, id, {}, META)).rejects.toThrow();
    expect((await stateOf(id)).payerState).toBeNull();
  });

  it("the database refuses a hold with no reason or no review date, and a state outside to_pay", async () => {
    const id = await requestInToPay();
    await expect(
      dbOwner.update(request).set({ payerState: "on_hold", payerStateReason: "", payerReviewOn: "2026-11-01", payerStateAt: new Date(), payerStateBy: payerUser.id }).where(eq(request.id, id)),
    ).rejects.toThrow();
    await expect(
      dbOwner.update(request).set({ payerState: "on_hold", payerStateReason: "funds", payerReviewOn: null, payerStateAt: new Date(), payerStateBy: payerUser.id }).where(eq(request.id, id)),
    ).rejects.toThrow();
    await expect(
      dbOwner.update(request).set({ stage: "with_accounts", payerState: "in_progress", payerStateAt: new Date(), payerStateBy: payerUser.id }).where(eq(request.id, id)),
    ).rejects.toThrow();
  });
});

describe("manual flags", () => {
  it("a desk raises a flag that shows in the computed flags, and clears it", async () => {
    const id = await requestInToPay();
    expect(await raiseManualFlag(approverUser.id, id, { reason: "bank details differ from the bill" }, META)).toEqual({ ok: true });

    const [row] = await dbOwner.select().from(requestFlag).where(eq(requestFlag.requestId, id));
    expect(row.raisedAsRole).toBe("approver");
    expect(row.clearedAt).toBeNull();

    const flags = await withGrantScope(payerUser.id, "payer", async (tx) => {
      const [req] = await tx.select().from(request).where(eq(request.id, id));
      return computeFlags(req, await loadFlagContext(tx, [req]));
    });
    expect(flags.filter((f) => f.key === "manual").map((f) => f.reason)).toEqual(["Flagged: bank details differ from the bill"]);

    expect(await clearManualFlag(payerUser.id, row.id, META)).toEqual({ ok: true });
    const [cleared] = await dbOwner.select().from(requestFlag).where(eq(requestFlag.id, row.id));
    expect(cleared.clearedBy).toBe(payerUser.id);
    expect((await clearManualFlag(payerUser.id, row.id, META)).ok).toBe(false);

    const after = await dbOwner.select().from(requestFlag).where(and(eq(requestFlag.requestId, id), isNull(requestFlag.clearedAt)));
    expect(after).toHaveLength(0);
    expect(await eventTypes(id)).toEqual(expect.arrayContaining(["request.flagged", "request.flag_cleared"]));
  });

  it("needs a reason, is refused to the requester, and stays possible under an open query", async () => {
    const id = await requestInToPay();
    expect((await raiseManualFlag(approverUser.id, id, { reason: " " }, META)).ok).toBe(false);

    const asRequester = await raiseManualFlag(requesterUser.id, id, { reason: "looks odd" }, META);
    expect(asRequester.ok).toBe(false);

    await raiseQuery(approverUser.id, id, { directedAt: ["requester"], question: "Is this the right vendor?" }, META);
    expect(await raiseManualFlag(payerUser.id, id, { reason: "vendor name differs" }, META)).toEqual({ ok: true });
  });

  it("a payer in another department cannot see or clear the flag", async () => {
    const id = await requestInToPay();
    await raiseManualFlag(approverUser.id, id, { reason: "duplicate suspicion" }, META);
    const [row] = await dbOwner.select().from(requestFlag).where(eq(requestFlag.requestId, id));

    const result = await clearManualFlag(payerUserB.id, row.id, META);
    expect(result.ok).toBe(false);
    const [still] = await dbOwner.select().from(requestFlag).where(eq(requestFlag.id, row.id));
    expect(still.clearedAt).toBeNull();
  });
});

describe("computeFlags with payer state", () => {
  const ctx = (over: Partial<FlagContext> = {}): FlagContext => ({
    now: new Date("2026-10-10T00:00:00Z"),
    ageingThresholdByDept: new Map([["d", 3]]),
    openQueryRequestIds: new Set(),
    repeatAmountRequestIds: new Set(),
    bankChangedRequestIds: new Set(),
    ...over,
  });
  const base = { id: "r", stage: "to_pay", departmentId: "d", createdAt: new Date("2026-09-01T00:00:00Z"), dueDate: null, vendorKey: null, amountMinor: 1, invoiceDate: null };

  it("a payer hold stops ageing, but in progress does not", () => {
    expect(computeFlags({ ...base, payerState: null }, ctx()).map((f) => f.key)).toContain("ageing");
    expect(computeFlags({ ...base, payerState: "in_progress" }, ctx()).map((f) => f.key)).toContain("ageing");
    expect(computeFlags({ ...base, payerState: "on_hold" }, ctx()).map((f) => f.key)).not.toContain("ageing");
  });

  it("every open manual flag is its own red flag", () => {
    const flags = computeFlags(base, ctx({ manualFlagReasons: new Map([["r", ["one", "two"]]]) })).filter((f) => f.key === "manual");
    expect(flags.map((f) => f.reason)).toEqual(["Flagged: one", "Flagged: two"]);
    expect(flags.every((f) => f.severity === "red")).toBe(true);
  });
});
