import { randomUUID } from "node:crypto";
import { eq, inArray, or } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeOwnerConnection, dbOwner } from "../scripts/db-owner";
import { hashSecret } from "../src/auth/password";
import { withGrantScope } from "../src/db/runtime";
import { department, duplicateCheck, event, extraction, extractionAttempt, request, requestFile, roleGrant, user } from "../src/db/schema";
import { computeDHash } from "../src/extraction/dhash";
import { needsEscalation, runExtraction } from "../src/extraction/extractCore";
import { parseExtractedFields } from "../src/extraction/schema";
import { type Attachment, submitRequest } from "../src/requests/captureCore";
import { presignPutUrl } from "../src/storage/r2";
import { buildStorageKey } from "../src/storage/storageKey";

// The phase-13 gate. Same philosophy as every other slice test file:
// exercises the real extractCore.ts/captureCore.ts against the real dev
// Supabase project and real R2, no mocks — EXCEPT the actual Anthropic
// model call, which ANTHROPIC_API_KEY being unset in this environment
// makes untestable live (matching RESEND_API_KEY's own "unset in CI"
// convention). What that buys for free: runExtraction's own "unconfigured
// integration fails visibly" path IS exercised for real below. Not
// attempted here: a real tier-1/tier-2 escalation round trip, and the
// browser-only confirmation-screen walkthrough — both need a real key
// added first.

const nonce = randomUUID().slice(0, 8);
const META = { ip: "203.0.113.60", userAgent: "vitest" };

async function uploadTestImage(): Promise<Attachment & { bytes: Buffer }> {
  const fileId = randomUUID();
  const mime = "image/jpeg";
  const storageKey = buildStorageKey("bills", fileId, mime);
  const uploadUrl = await presignPutUrl(storageKey, mime);
  const bytes = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 60, b: 60 } } }).jpeg().toBuffer();
  const response = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": mime }, body: bytes });
  if (!response.ok) throw new Error(`Test fixture upload failed: ${response.status}`);
  return { fileId, storageKey, mime, byteLength: bytes.length, sha256: randomUUID().padEnd(64, "0"), bytes };
}

async function uploadTestPdfPage(): Promise<Attachment> {
  const fileId = randomUUID();
  const mime = "application/pdf";
  const storageKey = buildStorageKey("bills", fileId, mime);
  const uploadUrl = await presignPutUrl(storageKey, mime);
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  const response = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": mime }, body: bytes });
  if (!response.ok) throw new Error(`Test fixture upload failed: ${response.status}`);
  return { fileId, storageKey, mime, byteLength: bytes.length, sha256: randomUUID().padEnd(64, "0") };
}

describe("extraction schema/decision logic (pure, the phase-13 gate)", () => {
  it("parseExtractedFields rejects anything not shaped like the tool's own schema", () => {
    expect(parseExtractedFields(null)).toBeNull();
    expect(parseExtractedFields({})).toBeNull();
    expect(parseExtractedFields({ vendor: { value: "Acme", confidence: 1.5 }, amount: { value: 100, confidence: 0.9 }, invoiceNo: { value: "1", confidence: 0.9 }, invoiceDate: { value: "2026-01-01", confidence: 0.9 }, gstin: { value: null, confidence: 0.5 } })).toBeNull(); // confidence out of range
    expect(parseExtractedFields({ vendor: { value: "Acme", confidence: 0.9 }, amount: { value: "not a number", confidence: 0.9 }, invoiceNo: { value: "1", confidence: 0.9 }, invoiceDate: { value: "2026-01-01", confidence: 0.9 }, gstin: { value: null, confidence: 0.5 } })).toBeNull(); // wrong value type
  });

  it("parseExtractedFields accepts a well-formed reading, nulls included", () => {
    const parsed = parseExtractedFields({
      vendor: { value: "Sundaram Auto Components", confidence: 0.92 },
      amount: { value: 184500, confidence: 0.97 },
      invoiceNo: { value: "SAC/25-26/0912", confidence: 0.58 },
      invoiceDate: { value: "2026-08-18", confidence: 0.99 },
      gstin: { value: null, confidence: 0.2 },
    });
    expect(parsed?.invoiceNo.value).toBe("SAC/25-26/0912");
    expect(parsed?.gstin.value).toBeNull();
  });

  it("needsEscalation fires when any decisive field is below its own floor, not for gstin/invoiceDate", () => {
    const high = { value: "x", confidence: 0.99 };
    const wellFormed = { vendor: high, amount: high, invoiceNo: high, invoiceDate: high, gstin: high };
    expect(needsEscalation(wellFormed)).toBe(false);

    expect(needsEscalation({ ...wellFormed, amount: { value: 1, confidence: 0.5 } })).toBe(true);
    expect(needsEscalation({ ...wellFormed, vendor: { value: "x", confidence: 0.5 } })).toBe(true);
    expect(needsEscalation({ ...wellFormed, invoiceNo: { value: "x", confidence: 0.5 } })).toBe(true);
    // Low confidence on a non-decisive field never triggers escalation.
    expect(needsEscalation({ ...wellFormed, gstin: { value: "x", confidence: 0.01 } })).toBe(false);
    expect(needsEscalation({ ...wellFormed, invoiceDate: { value: "x", confidence: 0.01 } })).toBe(false);
  });

  it("computeDHash is stable for the same image and differs for a visibly different one", async () => {
    const red = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 220, g: 20, b: 20 } } }).jpeg().toBuffer();
    const redAgain = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 220, g: 20, b: 20 } } }).jpeg().toBuffer();
    const blue = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 20, g: 20, b: 220 } } })
      .composite([{ input: await sharp({ create: { width: 20, height: 15, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer(), top: 0, left: 0 }])
      .jpeg()
      .toBuffer();

    const hashRed = await computeDHash(red);
    const hashRedAgain = await computeDHash(redAgain);
    const hashBlue = await computeDHash(blue);

    expect(hashRed).toHaveLength(16);
    expect(hashRed).toBe(hashRedAgain);
    expect(hashRed).not.toBe(hashBlue);
  });
});

let deptA: { id: string };
let requesterUser: { id: string };
let approverUser: { id: string };

async function grant(userId: string, role: string, opts: { deptIds?: string[] } = {}) {
  await dbOwner.insert(roleGrant).values({
    userId,
    role: role as (typeof roleGrant.$inferInsert)["role"],
    deptScope: opts.deptIds ? "list" : "global",
    departmentIds: opts.deptIds,
    companyScope: "n/a",
    grantedBy: userId,
  });
}

async function makeUser(label: string): Promise<{ id: string }> {
  const [u] = await dbOwner
    .insert(user)
    .values({ name: `Extraction Test ${label} ${nonce}`, email: `extraction-test-${label}-${nonce}@example.invalid`, passwordHash: await hashSecret("unused") })
    .returning({ id: user.id });
  return u;
}

beforeAll(async () => {
  [deptA] = await dbOwner.insert(department).values({ name: `Extraction Test Dept A ${nonce}`, code: `EXT-A-${nonce}`, ageingThresholdDays: 30 }).returning({ id: department.id });
  requesterUser = await makeUser("requester");
  approverUser = await makeUser("approver");
  await grant(requesterUser.id, "requester", { deptIds: [deptA.id] });
  await grant(approverUser.id, "approver", { deptIds: [deptA.id] });
});

afterAll(async () => {
  const userIds = [requesterUser.id, approverUser.id];
  const reqs = await dbOwner.select({ id: request.id }).from(request).where(eq(request.departmentId, deptA.id));
  const reqIds = reqs.map((r) => r.id);

  // extraction_attempt.request_id FKs to request — must go first.
  const attempts = await dbOwner.select({ id: extractionAttempt.id }).from(extractionAttempt).where(inArray(extractionAttempt.attemptedBy, userIds));
  const attemptIds = attempts.map((a) => a.id);
  if (attemptIds.length > 0) {
    await dbOwner.delete(extraction).where(inArray(extraction.attemptId, attemptIds));
    await dbOwner.delete(extractionAttempt).where(inArray(extractionAttempt.id, attemptIds));
  }

  if (reqIds.length > 0) {
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
  await dbOwner.delete(department).where(eq(department.id, deptA.id));
  await dbOwner.delete(user).where(inArray(user.id, userIds));
  await closeOwnerConnection();
}, 60_000);

describe("extraction against the real dev DB and R2 (the phase-13 gate)", () => {
  it("an unconfigured ANTHROPIC_API_KEY degrades to a recorded failed attempt, never silently", async () => {
    const file = await uploadTestImage();
    const result = await runExtraction(requesterUser.id, file.storageKey, file.mime);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.length).toBeGreaterThan(0);

    const [attempt] = await dbOwner.select().from(extractionAttempt).where(eq(extractionAttempt.id, result.attemptId));
    expect(attempt.status).toBe("failed");
    expect(attempt.requestId).toBeNull();
    expect(attempt.error).toContain("ANTHROPIC_API_KEY");
  });

  it("a submitted request backfills the attempt's requestId, diffs corrections, and applies phash to the first page only", async () => {
    const file = await uploadTestImage();
    const secondPage = await uploadTestPdfPage();

    // Simulate a completed extraction attempt directly (no live model
    // call available) — this is exactly the shape runExtraction would
    // have written itself.
    const attemptId = await withGrantScope(requesterUser.id, "requester", async (tx) => {
      const [attempt] = await tx
        .insert(extractionAttempt)
        .values({ storageKey: file.storageKey, attemptedBy: requesterUser.id, status: "succeeded", model: "claude-haiku-4-5-20251001", escalated: false })
        .returning({ id: extractionAttempt.id });
      await tx.insert(extraction).values([
        { attemptId: attempt.id, field: "vendor", value: "Sundaram Auto Components", confidence: 0.92 },
        { attemptId: attempt.id, field: "amount", value: "184500", confidence: 0.97 },
        { attemptId: attempt.id, field: "invoiceNo", value: "SAC/25-26/0912", confidence: 0.58 },
        { attemptId: attempt.id, field: "invoiceDate", value: "2026-08-18", confidence: 0.99 },
        { attemptId: attempt.id, field: "gstin", value: null, confidence: 0.2 },
        { attemptId: attempt.id, field: "currency", value: "INR", confidence: 1 },
      ]);
      return attempt.id;
    });
    const phash = await computeDHash(file.bytes);

    const result = await submitRequest({
      userId: requesterUser.id,
      ip: META.ip,
      userAgent: META.userAgent,
      departmentId: deptA.id,
      amountMinor: 184500 * 100,
      // Deliberately corrected from what was extracted (SAC/25-26/0912 -> /0913).
      invoiceNo: "SAC/25-26/0913",
      invoiceDate: "2026-08-18",
      vendor: "Sundaram Auto Components",
      attachments: [file, secondPage],
      extraction: { attemptId, phash },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [attempt] = await dbOwner.select().from(extractionAttempt).where(eq(extractionAttempt.id, attemptId));
    expect(attempt.requestId).toBe(result.requestId);

    const rows = await dbOwner.select().from(extraction).where(eq(extraction.attemptId, attemptId));
    const invoiceNoRow = rows.find((r) => r.field === "invoiceNo");
    expect(invoiceNoRow?.acceptedValue).toBe("SAC/25-26/0913");
    expect(invoiceNoRow?.correctedBy).toBe(requesterUser.id);
    const vendorRow = rows.find((r) => r.field === "vendor");
    expect(vendorRow?.acceptedValue).toBe("Sundaram Auto Components");
    expect(vendorRow?.correctedBy).toBeNull();

    const files = await dbOwner.select().from(requestFile).where(eq(requestFile.requestId, result.requestId));
    const firstPage = files.find((f) => f.pageNo === 1);
    const otherPage = files.find((f) => f.pageNo === 2);
    expect(firstPage?.phash).toBe(phash);
    expect(otherPage?.phash).toBeNull();

    const [raisedEvent] = await dbOwner.select().from(event).where(eq(event.requestId, result.requestId));
    const after = raisedEvent.after as { extraction?: { escalated: boolean; fieldsCorrected: number } };
    expect(after.extraction?.escalated).toBe(false);
    expect(after.extraction?.fieldsCorrected).toBe(1);
  });

  it("an out-of-scope actor cannot read another requester's extraction_attempt rows", async () => {
    const file = await uploadTestImage();
    const result = await runExtraction(requesterUser.id, file.storageKey, file.mime);
    expect(result.ok).toBe(false); // still no key configured; the attempt row is what we're checking RLS on

    const asOwner = await withGrantScope(requesterUser.id, "requester", (tx) =>
      tx.select({ id: extractionAttempt.id }).from(extractionAttempt).where(eq(extractionAttempt.id, result.attemptId)),
    );
    expect(asOwner).toHaveLength(1);

    const asApprover = await withGrantScope(approverUser.id, "approver", (tx) =>
      tx.select({ id: extractionAttempt.id }).from(extractionAttempt).where(eq(extractionAttempt.id, result.attemptId)),
    );
    expect(asApprover).toHaveLength(0);
  });
});
