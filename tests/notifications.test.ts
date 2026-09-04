import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeOwnerConnection, dbOwner } from "../scripts/db-owner";
import { accounting, comment, company, department, event, headOfAccount, payment, query, request, requestFile, roleGrant, user, vendor } from "../src/db/schema";
import { hashSecret } from "../src/auth/password";
import { sendEmail } from "../src/notifications/email";
import {
  notifyAccount,
  notifyApprove,
  notifyHold,
  notifyMentions,
  notifyNudge,
  notifyPay,
  notifyQueryAnswered,
  notifyQueryRaised,
  notifyReject,
  notifyResubmit,
  notifyReturnToAccounts,
  notifyReturnToApprover,
  notifyReturnToRequester,
} from "../src/notifications/recipients";
import { submitRequest, type Attachment } from "../src/requests/captureCore";
import { accountRequest, approveRequest } from "../src/requests/transitions";
import { presignPutUrl } from "../src/storage/r2";
import { buildStorageKey } from "../src/storage/storageKey";

// The phase-8 gate. Same philosophy as tests/{desks,comments,queries,nudges}
// .test.ts: exercises the real recipients.ts against the real dev Supabase
// project, no mocks — including no mocked Resend client. RESEND_API_KEY is
// deliberately unset in CI (.env.example says so), so every run here
// already exercises sendEmail's suppressed path; recipient RESOLUTION is
// what's under test, verified via each notifyX function's own return
// value (the emails it resolved and attempted to notify), which is
// testable without ever needing a live send. Explicitly NOT attempted
// here: actual inbox delivery with a real, domain-verified Resend key —
// that's a manual verification step once EMAIL_FROM's sending domain is
// configured.

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
let companyX: { id: string };
let companyY: { id: string };
let head: { id: string };
let testVendor: { id: string };

let requesterUser: { id: string; email: string };
let approverUser: { id: string; email: string };
let approverUserB: { id: string; email: string }; // deptB — out of scope
let accountantUser: { id: string; email: string }; // companyX
let accountantUserY: { id: string; email: string }; // companyY — out of scope
let payerUser: { id: string; email: string }; // companyX
let payerUserY: { id: string; email: string }; // companyY — out of scope
let dualRoleUser: { id: string; email: string }; // requester + approver in deptA, for self-actioned

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
      name: `Notif Test ${label} ${nonce}`,
      email: `notif-test-${label}-${nonce}@example.invalid`,
      passwordHash: await hashSecret("unused"),
    })
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
    amountMinor: 60000,
    attachments: [file],
  });
  if (!result.ok) throw new Error(result.error);
  return result.requestId;
}

beforeAll(async () => {
  [deptA] = await dbOwner.insert(department).values({ name: `Notif Test Dept A ${nonce}`, code: `NTF-A-${nonce}`, ageingThresholdDays: 30 }).returning({ id: department.id });
  [deptB] = await dbOwner.insert(department).values({ name: `Notif Test Dept B ${nonce}`, code: `NTF-B-${nonce}`, ageingThresholdDays: 30 }).returning({ id: department.id });
  [companyX] = await dbOwner.insert(company).values({ name: `Notif Test Co X ${nonce}`, legalName: `Notif Test Co X ${nonce} Pvt Ltd`, active: true }).returning({ id: company.id });
  [companyY] = await dbOwner.insert(company).values({ name: `Notif Test Co Y ${nonce}`, legalName: `Notif Test Co Y ${nonce} Pvt Ltd`, active: true }).returning({ id: company.id });
  [head] = await dbOwner.insert(headOfAccount).values({ name: `Notif Test Head ${nonce}`, code: `NTF-H-${nonce}`, active: true }).returning({ id: headOfAccount.id });

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
  await grant(accountantUserY.id, "accountant", { deptIds: [deptB.id], companyIds: [companyY.id] });
  await grant(payerUser.id, "payer", { companyIds: [companyX.id] });
  await grant(payerUserY.id, "payer", { deptIds: [deptB.id], companyIds: [companyY.id] });
  await grant(dualRoleUser.id, "requester", { deptIds: [deptA.id] });
  await grant(dualRoleUser.id, "approver", { deptIds: [deptA.id] });

  [testVendor] = await dbOwner
    .insert(vendor)
    .values({ name: `Notif Test Vendor ${nonce}`, createdBy: accountantUser.id })
    .returning({ id: vendor.id });
});

afterAll(async () => {
  const userIds = [
    requesterUser.id,
    approverUser.id,
    approverUserB.id,
    accountantUser.id,
    accountantUserY.id,
    payerUser.id,
    payerUserY.id,
    dualRoleUser.id,
  ];
  const reqs = await dbOwner.select({ id: request.id }).from(request).where(inArray(request.departmentId, [deptA.id, deptB.id]));
  const reqIds = reqs.map((r) => r.id);
  if (reqIds.length > 0) {
    await dbOwner.delete(comment).where(inArray(comment.requestId, reqIds));
    await dbOwner.delete(query).where(inArray(query.requestId, reqIds));
    await dbOwner.delete(payment).where(inArray(payment.requestId, reqIds));
    await dbOwner.delete(accounting).where(inArray(accounting.requestId, reqIds));
    await dbOwner.delete(event).where(inArray(event.requestId, reqIds));
    await dbOwner.delete(requestFile).where(inArray(requestFile.requestId, reqIds));
    await dbOwner.delete(request).where(inArray(request.id, reqIds));
  }
  await dbOwner.delete(roleGrant).where(inArray(roleGrant.userId, userIds));
  await dbOwner.delete(vendor).where(eq(vendor.id, testVendor.id));
  await dbOwner.delete(headOfAccount).where(eq(headOfAccount.id, head.id));
  await dbOwner.delete(department).where(inArray(department.id, [deptA.id, deptB.id]));
  await dbOwner.delete(company).where(inArray(company.id, [companyX.id, companyY.id]));
  await dbOwner.delete(user).where(inArray(user.id, userIds));
  await closeOwnerConnection();
});

describe("sendEmail (unconfigured path)", () => {
  it("never throws, regardless of recipients", async () => {
    await expect(sendEmail({ to: [], subject: "x", text: "x" })).resolves.toBeUndefined();
    await expect(sendEmail({ to: ["nobody@example.invalid"], subject: "x", text: "x" })).resolves.toBeUndefined();
  });
});

describe("notification recipients (the phase-8 gate)", () => {
  // Role-based recipient assertions use toContain/not.toContain rather
  // than toEqual: this dev DB also carries persistent, globally-scoped
  // walkthrough accounts from earlier phases (e.g. approver@awa-pay.test),
  // which legitimately match "any accountant/approver/payer scoped to
  // this department" too — a strict array-equality check would be a test
  // artifact of a shared DB, not a real assertion about this code.

  it("notifyApprove reaches accountants scoped to the department, excluding the actor", async () => {
    const requestId = await raiseTestRequest();
    const emails = await notifyApprove(approverUser.id, requestId);
    expect(emails).toContain(accountantUser.email);
    expect(emails).not.toContain(approverUser.email);
  });

  it("notifyReturnToRequester/Hold/Reject all reach exactly the requester, and never the actor when self-actioned", async () => {
    const requestId = await raiseTestRequest();
    expect(await notifyReturnToRequester(approverUser.id, requestId, "wrong dept")).toEqual([requesterUser.email]);

    const requestId2 = await raiseTestRequest();
    expect(await notifyHold(approverUser.id, requestId2, "vendor issue")).toEqual([requesterUser.email]);

    const requestId3 = await raiseTestRequest();
    expect(await notifyReject(approverUser.id, requestId3, "duplicate")).toEqual([requesterUser.email]);

    // Self-actioned: dualRoleUser holds both requester and approver in
    // deptA and raises, then declines, their own request — should never
    // end up emailing themselves (AGENTS.md: self-approval/self-action is
    // permitted and recorded, never blocked, but also never self-notified).
    const file = await uploadTestFile();
    const raised = await submitRequest({ userId: dualRoleUser.id, ip: META.ip, userAgent: META.userAgent, departmentId: deptA.id, amountMinor: 45000, attachments: [file] });
    if (!raised.ok) throw new Error(raised.error);
    expect(await notifyReject(dualRoleUser.id, raised.requestId, "changed my mind")).toEqual([]);
  });

  it("notifyAccount reaches payers scoped to department AND company, once accounted", async () => {
    const requestId = await raiseTestRequest();
    await approveRequest(approverUser.id, requestId, { cycle: "unspecified", dueDate: null, noteToAccountsAndPayer: null }, META);
    await accountRequest(accountantUser.id, requestId, { companyId: companyX.id, vendorId: testVendor.id, headId: head.id, voucherNo: `PV-${nonce}-1`, bookedOn: "2026-08-20" }, META);

    const emails = await notifyAccount(accountantUser.id, requestId);
    expect(emails).toContain(payerUser.email);
    expect(emails).not.toContain(payerUserY.email); // companyY payer excluded
  });

  it("notifyReturnToApprover reaches approvers scoped to the department", async () => {
    const requestId = await raiseTestRequest();
    const emails = await notifyReturnToApprover(accountantUser.id, requestId, "wrong head");
    expect(emails).toContain(approverUser.email);
    expect(emails).not.toContain(approverUserB.email);
  });

  it("notifyPay reaches the requester", async () => {
    const requestId = await raiseTestRequest();
    const emails = await notifyPay(payerUser.id, requestId);
    expect(emails).toEqual([requesterUser.email]);
  });

  it("notifyReturnToAccounts reaches accountants scoped to department AND company", async () => {
    const requestId = await raiseTestRequest();
    await approveRequest(approverUser.id, requestId, { cycle: "unspecified", dueDate: null, noteToAccountsAndPayer: null }, META);
    await accountRequest(accountantUser.id, requestId, { companyId: companyX.id, vendorId: testVendor.id, headId: head.id, voucherNo: `PV-${nonce}-2`, bookedOn: "2026-08-20" }, META);

    const emails = await notifyReturnToAccounts(payerUser.id, requestId, "bank mismatch");
    expect(emails).toContain(accountantUser.email);
    expect(emails).not.toContain(accountantUserY.email);
  });

  it("notifyResubmit reaches approvers scoped to the department", async () => {
    const requestId = await raiseTestRequest();
    const emails = await notifyResubmit(requesterUser.id, requestId);
    expect(emails).toContain(approverUser.email);
  });

  it("notifyQueryRaised reaches the directedAt roles, notifyQueryAnswered reaches exactly the original raiser", async () => {
    const requestId = await raiseTestRequest();
    // directedAt is role-based (query.directedAt is role[], not user ids),
    // so this — like the other role-based notifiers above — can
    // legitimately also reach other requesters scoped to this department.
    const raisedEmails = await notifyQueryRaised(approverUser.id, "approver", requestId, ["requester"], "Is this the right vendor?");
    expect(raisedEmails).toContain(requesterUser.email);

    // notifyQueryAnswered targets one specific user (whoever raised this
    // particular query), not a role, so this one is exact.
    const answeredEmails = await notifyQueryAnswered(requesterUser.id, "requester", requestId, approverUser.id, "Yes, confirmed.");
    expect(answeredEmails).toEqual([approverUser.email]);
  });

  it("notifyNudge reaches the nudge's own toRole", async () => {
    const requestId = await raiseTestRequest();
    const emails = await notifyNudge(requesterUser.id, "requester", requestId, "approver");
    expect(emails).toContain(approverUser.email);
  });

  it("notifyMentions reaches exactly the resolved mentions, excluding the actor", async () => {
    const requestId = await raiseTestRequest();
    const emails = await notifyMentions(requesterUser.id, "requester", requestId, [approverUser.id, requesterUser.id], "cc both of you");
    expect(emails).toEqual([approverUser.email]);
  });
});
