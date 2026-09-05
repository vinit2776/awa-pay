import { createHash, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeOwnerConnection, dbOwner } from "../scripts/db-owner";
import { hashSecret } from "../src/auth/password";
import { UnauthorizedGrantError, withGrantScope } from "../src/db/runtime";
import { department, event, request, requestFile, roleGrant, user } from "../src/db/schema";
import { computeEventHash } from "../src/events/hash";
import { parseAmountToMinor } from "../src/lib/money";
import { submitRequest, type Attachment } from "../src/requests/captureCore";
import { presignPutUrl } from "../src/storage/r2";
import { buildStorageKey } from "../src/storage/storageKey";

// The phase-3 gate. Exercises the real pure core (captureCore.submitRequest)
// against the real dev Supabase project AND real R2 — including the actual
// presign -> PUT -> HEAD-verify path, not a mocked one, matching this
// project's established "exercise the real path" testing philosophy.

const nonce = randomUUID().slice(0, 8);

async function uploadTestFile(bytes: Buffer): Promise<Attachment> {
  const fileId = randomUUID();
  const mime = "application/pdf";
  const storageKey = buildStorageKey("bills", fileId, mime);
  const uploadUrl = await presignPutUrl(storageKey, mime);

  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": mime },
    body: new Uint8Array(bytes),
  });
  if (!response.ok) {
    throw new Error(`Test fixture upload failed: ${response.status}`);
  }

  return {
    fileId,
    storageKey,
    mime,
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

let deptA: { id: string };
let deptB: { id: string };
let requesterUser: { id: string };

beforeAll(async () => {
  [deptA] = await dbOwner
    .insert(department)
    .values({ name: `Capture Test Dept A ${nonce}`, code: `CAP-A-${nonce}`, ageingThresholdDays: 30 })
    .returning({ id: department.id });

  [deptB] = await dbOwner
    .insert(department)
    .values({ name: `Capture Test Dept B ${nonce}`, code: `CAP-B-${nonce}`, ageingThresholdDays: 30 })
    .returning({ id: department.id });

  [requesterUser] = await dbOwner
    .insert(user)
    .values({
      name: `Capture Test Requester ${nonce}`,
      email: `capture-test-${nonce}@example.invalid`,
      passwordHash: await hashSecret("unused-in-capture-test"),
    })
    .returning({ id: user.id });

  await dbOwner.insert(roleGrant).values({
    userId: requesterUser.id,
    role: "requester",
    deptScope: "list",
    departmentIds: [deptA.id],
    companyScope: "n/a",
    grantedBy: requesterUser.id,
  });
});

afterAll(async () => {
  const requests = await dbOwner
    .select({ id: request.id })
    .from(request)
    .where(inArray(request.departmentId, [deptA.id, deptB.id]));
  const requestIds = requests.map((r) => r.id);

  if (requestIds.length > 0) {
    await dbOwner.delete(event).where(inArray(event.requestId, requestIds));
    await dbOwner.delete(requestFile).where(inArray(requestFile.requestId, requestIds));
    await dbOwner.delete(request).where(inArray(request.id, requestIds));
  }
  await dbOwner.delete(roleGrant).where(eq(roleGrant.userId, requesterUser.id));
  await dbOwner.delete(department).where(inArray(department.id, [deptA.id, deptB.id]));
  await dbOwner.delete(user).where(eq(user.id, requesterUser.id));
  await closeOwnerConnection();
});

describe("capture (the phase-3 gate)", () => {
  it(
    "a submitted request produces one request row, correctly-ordered request_file rows, and one event row",
    async () => {
      const fileA = await uploadTestFile(Buffer.from("page one"));
      const fileB = await uploadTestFile(Buffer.from("page two"));

      const result = await submitRequest({
        userId: requesterUser.id,
        ip: "203.0.113.20",
        userAgent: "vitest",
        departmentId: deptA.id,
        amountMinor: 184500,
        invoiceNo: "SAC/25-26/0912",
        invoiceDate: "2026-08-18",
        vendor: "Sundaram Auto Components",
        note: "test note",
        attachments: [fileA, fileB],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.ref).toMatch(/^REQ-\d+$/);

      const files = await withGrantScope(requesterUser.id, "requester", (tx) =>
        tx
          .select()
          .from(requestFile)
          .where(eq(requestFile.requestId, result.requestId))
          .orderBy(requestFile.pageNo),
      );
      expect(files).toHaveLength(2);
      expect(files[0].pageNo).toBe(1);
      expect(files[1].pageNo).toBe(2);
      expect(files[0].sha256).toBe(fileA.sha256);

      const events = await withGrantScope(requesterUser.id, "requester", (tx) =>
        tx.select().from(event).where(eq(event.requestId, result.requestId)),
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("request.raised");
      expect(events[0].prevHash).toBeNull();
      expect(events[0].hash).toHaveLength(64);
    },
  );

  it(
    "a requester scoped to one department cannot raise a request into another",
    async () => {
      const file = await uploadTestFile(Buffer.from("wrong department"));

      // Unlike SELECT (rows silently invisible), an INSERT that fails RLS's
      // WITH CHECK raises a real Postgres error — proving the RLS policy
      // is load-bearing, not just the department dropdown's client-side
      // filtering (which would never offer deptB to this user anyway).
      await expect(
        submitRequest({
          userId: requesterUser.id,
          ip: "203.0.113.20",
          userAgent: "vitest",
          departmentId: deptB.id, // not in this user's scope
          amountMinor: 1000,
          attachments: [file],
        }),
      ).rejects.toThrow();
    },
  );

  it(
    "rejects a user with no active requester grant",
    async () => {
      const [strangerUser] = await dbOwner
        .insert(user)
        .values({
          name: `Capture Test Stranger ${nonce}`,
          email: `capture-test-stranger-${nonce}@example.invalid`,
          passwordHash: await hashSecret("unused"),
        })
        .returning({ id: user.id });

      const file = await uploadTestFile(Buffer.from("no grant"));

      await expect(
        submitRequest({
          userId: strangerUser.id,
          ip: "203.0.113.20",
          userAgent: "vitest",
          departmentId: deptA.id,
          amountMinor: 1000,
          attachments: [file],
        }),
      ).rejects.toThrow(UnauthorizedGrantError);

      await dbOwner.delete(user).where(eq(user.id, strangerUser.id));
    },
  );

  it("ref numbers are unique across concurrent submits", async () => {
    const files = await Promise.all([
      uploadTestFile(Buffer.from("concurrent 1")),
      uploadTestFile(Buffer.from("concurrent 2")),
      uploadTestFile(Buffer.from("concurrent 3")),
    ]);

    const results = await Promise.all(
      files.map((file) =>
        submitRequest({
          userId: requesterUser.id,
          ip: "203.0.113.20",
          userAgent: "vitest",
          departmentId: deptA.id,
          amountMinor: 500,
          attachments: [file],
        }),
      ),
    );

    const refs = results.map((r) => (r.ok ? r.ref : null));
    expect(new Set(refs).size).toBe(3);
    expect(refs.every((r) => r !== null)).toBe(true);
  });
});

describe("computeEventHash", () => {
  const baseFields = {
    requestId: "11111111-1111-1111-1111-111111111111",
    actor: "22222222-2222-2222-2222-222222222222",
    roleAtTime: "requester",
    type: "request.raised",
    objectType: "request",
    objectId: "11111111-1111-1111-1111-111111111111",
    before: null,
    after: { ref: "REQ-1" },
    reason: null,
  };

  it("is deterministic for identical input", () => {
    expect(computeEventHash(baseFields, null)).toBe(computeEventHash(baseFields, null));
  });

  it("changes when any field changes", () => {
    const hash1 = computeEventHash(baseFields, null);
    const hash2 = computeEventHash({ ...baseFields, after: { ref: "REQ-2" } }, null);
    expect(hash1).not.toBe(hash2);
  });

  it("changes when prevHash changes", () => {
    const hash1 = computeEventHash(baseFields, null);
    const hash2 = computeEventHash(baseFields, "some-prior-hash");
    expect(hash1).not.toBe(hash2);
  });
});

describe("parseAmountToMinor", () => {
  it("parses a plain integer", () => {
    expect(parseAmountToMinor("1500")).toBe(150000);
  });

  it("parses two decimal places without float drift", () => {
    expect(parseAmountToMinor("19.99")).toBe(1999);
  });

  it("pads a single decimal place", () => {
    expect(parseAmountToMinor("19.5")).toBe(1950);
  });

  it("rejects zero and negative amounts", () => {
    expect(parseAmountToMinor("0")).toBeNull();
    expect(parseAmountToMinor("-5")).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(parseAmountToMinor("abc")).toBeNull();
    expect(parseAmountToMinor("19.999")).toBeNull();
    expect(parseAmountToMinor("")).toBeNull();
  });
});
