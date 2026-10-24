import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeOwnerConnection, dbOwner } from "../scripts/db-owner";
import { cleanupFixturesForNonce } from "../scripts/fixtures";
import { withGrantScope } from "../src/db/runtime";
import { department, event, nudge, roleGrant, user } from "../src/db/schema";
import { hashSecret } from "../src/auth/password";
import { sendNudge } from "../src/conversation/nudgesCore";
import { submitRequest, type Attachment } from "../src/requests/captureCore";
import { rejectRequest } from "../src/requests/transitions";
import { presignPutUrl } from "../src/storage/r2";
import { buildStorageKey } from "../src/storage/storageKey";

// The phase-7 gate. Same philosophy as tests/{desks,comments,queries}.test.ts:
// exercises the real nudgesCore.ts against the real dev Supabase project,
// no mocks. Explicitly browser-only, NOT attempted here: the amber Nudge
// button's visual styling, a live click-through walkthrough.

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

let requesterUser: { id: string; email: string };
let approverUser: { id: string };
let approverUserB: { id: string }; // deptB — out of scope

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

async function makeUser(label: string): Promise<{ id: string; email: string }> {
  const [u] = await dbOwner
    .insert(user)
    .values({ name: `Nudges Test ${label} ${nonce}`, email: `nudges-test-${label}-${nonce}@example.invalid`, passwordHash: await hashSecret("unused") })
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
    amountMinor: 42000,
    attachments: [file],
  });
  if (!result.ok) throw new Error(result.error);
  return result.requestId;
}

beforeAll(async () => {
  [deptA] = await dbOwner.insert(department).values({ name: `Nudges Test Dept A ${nonce}`, code: `NDG-A-${nonce}`, ageingThresholdDays: 30 }).returning({ id: department.id });
  [deptB] = await dbOwner.insert(department).values({ name: `Nudges Test Dept B ${nonce}`, code: `NDG-B-${nonce}`, ageingThresholdDays: 30 }).returning({ id: department.id });

  requesterUser = await makeUser("requester");
  approverUser = await makeUser("approver");
  approverUserB = await makeUser("approver-b");

  await grant(requesterUser.id, "requester", { deptIds: [deptA.id] });
  await grant(approverUser.id, "approver", { deptIds: [deptA.id] });
  await grant(approverUserB.id, "approver", { deptIds: [deptB.id] });
});

afterAll(async () => {
  try {
    await cleanupFixturesForNonce(dbOwner, nonce);
  } finally {
    await closeOwnerConnection();
  }
});

describe("nudges (the phase-7 gate)", () => {
  it("a nudge is aimed at whoever currently owns the stage, and appears in the trail", async () => {
    const requestId = await raiseTestRequest();

    const result = await sendNudge(requesterUser.id, requestId, META);
    expect(result.ok).toBe(true);

    const events = await withGrantScope(requesterUser.id, "requester", (tx) => tx.select().from(event).where(eq(event.requestId, requestId)));
    const nudgedEvent = events.find((e) => e.type === "request.nudged");
    expect(nudgedEvent).toBeTruthy();
    expect((nudgedEvent?.after as { toRole?: string })?.toRole).toBe("approver");
  });

  it("a second nudge from the same person on the same request the same day is rejected", async () => {
    const requestId = await raiseTestRequest();

    const first = await sendNudge(requesterUser.id, requestId, META);
    expect(first.ok).toBe(true);

    const second = await sendNudge(requesterUser.id, requestId, META);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toMatch(/already nudged/i);
  });

  it("two concurrent nudges from the same person race safely: exactly one succeeds", async () => {
    const requestId = await raiseTestRequest();

    const results = await Promise.all([sendNudge(requesterUser.id, requestId, META), sendNudge(requesterUser.id, requestId, META)]);
    const succeeded = results.filter((r) => r.ok);
    expect(succeeded).toHaveLength(1);

    const rows = await withGrantScope(requesterUser.id, "requester", (tx) => tx.select().from(nudge).where(eq(nudge.requestId, requestId)));
    expect(rows).toHaveLength(1);
  });

  it("a different person can still nudge the same request the same day", async () => {
    const requestId = await raiseTestRequest();
    const fromRequester = await sendNudge(requesterUser.id, requestId, META);
    expect(fromRequester.ok).toBe(true);
    const fromApprover = await sendNudge(approverUser.id, requestId, META);
    expect(fromApprover.ok).toBe(true);
  });

  it("a nudge on a closed request is refused — nobody is waiting on it", async () => {
    const requestId = await raiseTestRequest();
    await rejectRequest(approverUser.id, requestId, { reason: "Duplicate of an existing bill." }, META);

    const result = await sendNudge(requesterUser.id, requestId, META);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/nothing is waiting/i);
  });

  it("an out-of-scope role cannot nudge and never sees the nudge", async () => {
    const requestId = await raiseTestRequest();
    const attempt = await sendNudge(approverUserB.id, requestId, META);
    expect(attempt.ok).toBe(false);

    await sendNudge(requesterUser.id, requestId, META);
    const rows = await withGrantScope(approverUserB.id, "approver", (tx) => tx.select().from(nudge).where(eq(nudge.requestId, requestId)));
    expect(rows).toHaveLength(0);
  });
});
