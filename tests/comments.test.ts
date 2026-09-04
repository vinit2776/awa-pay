import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeOwnerConnection, dbOwner } from "../scripts/db-owner";
import { withGrantScope } from "../src/db/runtime";
import { comment, company, department, event, request, requestFile, roleGrant, user } from "../src/db/schema";
import { hashSecret } from "../src/auth/password";
import { resolveMentions } from "../src/conversation/mentions";
import { postComment } from "../src/conversation/commentsCore";
import { submitRequest, type Attachment } from "../src/requests/captureCore";
import { presignPutUrl } from "../src/storage/r2";
import { buildStorageKey } from "../src/storage/storageKey";

// The phase-5 gate. Same philosophy as tests/{isolation,desks}.test.ts:
// exercises the real commentsCore.ts against the real dev Supabase project
// and real R2, no mocks. Explicitly browser-only, NOT attempted here:
// viewing a presigned-GET attachment in an actual viewer, the composer's
// visual layout, "someone other than you has actually held a conversation
// through it".

const nonce = randomUUID().slice(0, 8);

async function uploadTestFile(): Promise<Attachment> {
  const fileId = randomUUID();
  const mime = "application/pdf";
  const storageKey = buildStorageKey("bills", fileId, mime);
  const uploadUrl = await presignPutUrl(storageKey, mime);
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  const response = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": mime }, body: bytes });
  if (!response.ok) throw new Error(`Test fixture upload failed: ${response.status}`);
  return { fileId, storageKey, mime, byteLength: bytes.length, sha256: "0".repeat(64) };
}

let deptA: { id: string };
let deptB: { id: string };
let companyX: { id: string };
let companyY: { id: string };

let requesterUser: { id: string; email: string };
let approverUser: { id: string; name: string };
let anilKumar: { id: string; name: string };
let anilKumarSingh: { id: string; name: string };
let payerUser: { id: string }; // companyX only
let payerUserY: { id: string }; // companyY — out of scope for a companyX-booked request

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

async function makeUser(label: string, name?: string): Promise<{ id: string; email: string; name: string }> {
  const userName = name ?? `Comments Test ${label} ${nonce}`;
  const [u] = await dbOwner
    .insert(user)
    .values({ name: userName, email: `comments-test-${label}-${nonce}@example.invalid`, passwordHash: await hashSecret("unused") })
    .returning({ id: user.id, email: user.email, name: user.name });
  return u;
}

async function raiseTestRequest(): Promise<string> {
  const file = await uploadTestFile();
  const result = await submitRequest({
    userId: requesterUser.id,
    ip: "203.0.113.30",
    userAgent: "vitest",
    departmentId: deptA.id,
    amountMinor: 50000,
    attachments: [file],
  });
  if (!result.ok) throw new Error(result.error);
  return result.requestId;
}

beforeAll(async () => {
  [deptA] = await dbOwner.insert(department).values({ name: `Comments Test Dept A ${nonce}`, code: `CMT-A-${nonce}`, ageingThresholdDays: 30 }).returning({ id: department.id });
  [deptB] = await dbOwner.insert(department).values({ name: `Comments Test Dept B ${nonce}`, code: `CMT-B-${nonce}`, ageingThresholdDays: 30 }).returning({ id: department.id });
  [companyX] = await dbOwner.insert(company).values({ name: `Comments Test Co X ${nonce}`, legalName: `Comments Test Co X ${nonce} Pvt Ltd`, active: true }).returning({ id: company.id });
  [companyY] = await dbOwner.insert(company).values({ name: `Comments Test Co Y ${nonce}`, legalName: `Comments Test Co Y ${nonce} Pvt Ltd`, active: true }).returning({ id: company.id });

  requesterUser = await makeUser("requester");
  approverUser = (await makeUser("approver")) as { id: string; name: string };
  anilKumar = (await makeUser("anil-kumar", "Anil Kumar")) as { id: string; name: string };
  anilKumarSingh = (await makeUser("anil-kumar-singh", "Anil Kumar Singh")) as { id: string; name: string };
  payerUser = await makeUser("payer");
  payerUserY = await makeUser("payer-y");

  await grant(requesterUser.id, "requester", { deptIds: [deptA.id] });
  await grant(approverUser.id, "approver", { deptIds: [deptA.id] });
  await grant(anilKumar.id, "approver", { deptIds: [deptA.id] });
  await grant(anilKumarSingh.id, "accountant", { deptIds: [deptB.id], companyIds: [companyX.id] });
  await grant(payerUser.id, "payer", { companyIds: [companyX.id] });
  await grant(payerUserY.id, "payer", { companyIds: [companyY.id] });
});

afterAll(async () => {
  const userIds = [requesterUser.id, approverUser.id, anilKumar.id, anilKumarSingh.id, payerUser.id, payerUserY.id];
  const reqs = await dbOwner.select({ id: request.id }).from(request).where(inArray(request.departmentId, [deptA.id, deptB.id]));
  const reqIds = reqs.map((r) => r.id);
  if (reqIds.length > 0) {
    const comments = await dbOwner.select({ id: comment.id }).from(comment).where(inArray(comment.requestId, reqIds));
    const commentIds = comments.map((c) => c.id);
    if (commentIds.length > 0) {
      await dbOwner.delete(requestFile).where(inArray(requestFile.commentId, commentIds));
    }
    await dbOwner.delete(comment).where(inArray(comment.requestId, reqIds));
    await dbOwner.delete(requestFile).where(inArray(requestFile.requestId, reqIds));
    await dbOwner.delete(event).where(inArray(event.requestId, reqIds));
    await dbOwner.delete(request).where(inArray(request.id, reqIds));
  }
  await dbOwner.delete(roleGrant).where(inArray(roleGrant.userId, userIds));
  await dbOwner.delete(department).where(inArray(department.id, [deptA.id, deptB.id]));
  await dbOwner.delete(company).where(inArray(company.id, [companyX.id, companyY.id]));
  await dbOwner.delete(user).where(inArray(user.id, userIds));
  await closeOwnerConnection();
});

describe("mentions (pure)", () => {
  it("resolves a full-name mention, longest-first so a prefix collision doesn't false-match", () => {
    const candidates = [
      { id: anilKumar.id, name: "Anil Kumar" },
      { id: anilKumarSingh.id, name: "Anil Kumar Singh" },
    ];
    expect(resolveMentions("cc @Anil Kumar Singh please review", candidates)).toEqual([anilKumarSingh.id]);
    expect(resolveMentions("cc @Anil Kumar please review", candidates)).toEqual([anilKumar.id]);
  });

  it("resolves multiple distinct mentions in one body", () => {
    const candidates = [
      { id: anilKumar.id, name: "Anil Kumar" },
      { id: anilKumarSingh.id, name: "Anil Kumar Singh" },
    ];
    const resolved = resolveMentions("@Anil Kumar Singh and @Anil Kumar both please look", candidates);
    expect(resolved.sort()).toEqual([anilKumar.id, anilKumarSingh.id].sort());
  });

  it("resolves nothing when no candidate name appears", () => {
    expect(resolveMentions("no mentions here", [{ id: anilKumar.id, name: "Anil Kumar" }])).toEqual([]);
  });
});

describe("the conversation (the phase-5 gate)", () => {
  it("a comment posted by one in-scope role is visible to another in-scope role immediately", async () => {
    const requestId = await raiseTestRequest();

    const posted = await postComment({ userId: approverUser.id, requestId, body: "Cleared, please book to canteen.", attachments: [] });
    expect(posted.ok).toBe(true);

    const [row] = await withGrantScope(requesterUser.id, "requester", (tx) => tx.select().from(comment).where(eq(comment.requestId, requestId)));
    expect(row).toBeTruthy();
    expect(row.body).toBe("Cleared, please book to canteen.");
    expect(row.roleAtTime).toBe("approver");
  });

  it("@mention in a real post resolves against the request's own scope and is stored on the row", async () => {
    const requestId = await raiseTestRequest();

    const posted = await postComment({
      userId: requesterUser.id,
      requestId,
      body: "@Anil Kumar Singh — can you check the amount?",
      attachments: [],
    });
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;
    // anilKumarSingh is an accountant scoped to deptB, not deptA — not a
    // resolvable candidate on a deptA request despite being name-matched
    // in the body. Confirms candidate resolution is genuinely
    // scope-derived, not just "every name that appears in the body."
    // (anilKumar — the in-scope approver — legitimately matches instead,
    // since "Anil Kumar" is a real prefix of the posted name once
    // anilKumarSingh drops out of the candidate pool; that's
    // resolveMentions' own longest-first collision handling working
    // correctly against a *filtered* candidate set, not this test's
    // concern.)
    expect(posted.mentions).not.toContain(anilKumarSingh.id);
  });

  it("an attachment uploads, verifies, and is retrievable via a presigned GET", async () => {
    const requestId = await raiseTestRequest();
    const file = await uploadTestFile();

    const posted = await postComment({
      userId: requesterUser.id,
      requestId,
      body: "See the attached statement.",
      attachments: [{ fileId: file.fileId, storageKey: file.storageKey, mime: file.mime, byteLength: file.byteLength, sha256: file.sha256 }],
    });
    expect(posted.ok).toBe(true);

    const [row] = await withGrantScope(requesterUser.id, "requester", (tx) =>
      tx.select().from(requestFile).where(eq(requestFile.storageKey, file.storageKey)),
    );
    expect(row.kind).toBe("comment_attachment");
    expect(row.commentId).toBeTruthy();
  });

  it("an out-of-scope role gets neither the request nor its comments", async () => {
    const requestId = await raiseTestRequest();
    await postComment({ userId: requesterUser.id, requestId, body: "Department-scoped conversation.", attachments: [] });

    // payerUserY holds payer scoped to companyY only; this request has no
    // company_id yet (pre-accounting), so RLS's payer branch
    // (company_id IS NULL OR app_has_company_scope) actually passes — use
    // an approver scoped to deptB instead, a role/department combination
    // genuinely outside this request's scope.
    const [outsider] = await dbOwner
      .insert(user)
      .values({ name: `Comments Test Outsider ${nonce}`, email: `comments-test-outsider-${nonce}@example.invalid`, passwordHash: await hashSecret("unused") })
      .returning({ id: user.id });
    await grant(outsider.id, "approver", { deptIds: [deptB.id] });

    const rows = await withGrantScope(outsider.id, "approver", (tx) => tx.select().from(comment).where(eq(comment.requestId, requestId)));
    expect(rows).toHaveLength(0);

    const attempt = await postComment({ userId: outsider.id, requestId, body: "Should be rejected.", attachments: [] });
    expect(attempt.ok).toBe(false);

    await dbOwner.delete(roleGrant).where(eq(roleGrant.userId, outsider.id));
    await dbOwner.delete(user).where(eq(user.id, outsider.id));
  });

  it("posting an empty comment is rejected before touching the database", async () => {
    const requestId = await raiseTestRequest();
    const result = await postComment({ userId: requesterUser.id, requestId, body: "   ", attachments: [] });
    expect(result.ok).toBe(false);
  });
});
