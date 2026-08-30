import { sql } from "drizzle-orm";
import { withGrantScope } from "@/db/runtime";
import { event, request, requestFile } from "@/db/schema";
import { computeEventHash } from "@/events/hash";
import { headObjectContentLength } from "@/storage/r2";

// Pure orchestration, no next/headers or next/navigation — testable
// directly from Vitest. src/app/(app)/requests/new/actions.ts is the thin
// "use server" wrapper that gathers ip/userAgent via headers() and calls
// this.

export type Attachment = {
  fileId: string;
  storageKey: string;
  mime: string;
  byteLength: number;
  sha256: string;
};

export type SubmitRequestParams = {
  userId: string;
  ip: string;
  userAgent: string | undefined;
  departmentId: string;
  amountMinor: number;
  currency?: string;
  invoiceNo?: string;
  invoiceDate?: string;
  vendor?: string;
  note?: string;
  attachments: Attachment[];
};

export type SubmitRequestResult = { ok: true; ref: string; requestId: string } | { ok: false; error: string };

export async function submitRequest(params: SubmitRequestParams): Promise<SubmitRequestResult> {
  if (params.amountMinor <= 0) {
    return { ok: false, error: "Enter a valid amount." };
  }
  if (params.attachments.length === 0) {
    return { ok: false, error: "Attach at least one file." };
  }

  // Server-side corroboration for "checksum on arrival" (see
  // src/storage/r2.ts's header comment for what this does and doesn't
  // guarantee) — reject before opening any transaction if a file's length
  // doesn't match what R2 actually received.
  for (const attachment of params.attachments) {
    const actualLength = await headObjectContentLength(attachment.storageKey);
    if (actualLength === null || actualLength !== attachment.byteLength) {
      return { ok: false, error: "One of the uploaded files could not be verified. Please try again." };
    }
  }

  const currency = params.currency ?? "INR";

  const newRequest = await withGrantScope(params.userId, "requester", async (tx) => {
    const [inserted] = await tx
      .insert(request)
      .values({
        // Computed inline in this insert, inside the same transaction as
        // the row it names — no separate round trip to race or skip. See
        // drizzle/migrations/0004_request_ref_sequence.sql.
        ref: sql`'REQ-' || nextval('request_ref_seq')`,
        // Nothing transitions raised -> awaiting_approval separately — there
        // is no "submit for approval" step distinct from capture itself, so
        // a freshly captured request goes straight to the approver's queue.
        // 'raised' (the schema default) is reserved for exactly one other
        // case: a request an approver has returned to the requester for
        // correction. See src/requests/transitions.ts.
        stage: "awaiting_approval",
        departmentId: params.departmentId,
        raisedBy: params.userId,
        currency,
        amountMinor: params.amountMinor,
        invoiceNo: params.invoiceNo,
        invoiceDate: params.invoiceDate,
        vendor: params.vendor,
        note: params.note,
      })
      .returning();

    for (const [i, attachment] of params.attachments.entries()) {
      await tx.insert(requestFile).values({
        id: attachment.fileId,
        requestId: inserted.id,
        storageKey: attachment.storageKey,
        pageNo: i + 1,
        mime: attachment.mime,
        bytes: attachment.byteLength,
        sha256: attachment.sha256,
        uploadedBy: params.userId,
      });
    }

    const eventFields = {
      requestId: inserted.id,
      actor: params.userId,
      roleAtTime: "requester",
      type: "request.raised",
      objectType: "request",
      objectId: inserted.id,
      before: null,
      after: {
        ref: inserted.ref,
        departmentId: params.departmentId,
        amountMinor: params.amountMinor,
        currency,
        invoiceNo: params.invoiceNo ?? null,
        invoiceDate: params.invoiceDate ?? null,
        vendor: params.vendor ?? null,
        note: params.note ?? null,
        fileCount: params.attachments.length,
        stage: "raised",
      },
      reason: null,
    };
    // request.raised is always the first event a new request gets, so
    // prevHash is unambiguously null here — see src/events/hash.ts.
    const hash = computeEventHash(eventFields, null);

    await tx.insert(event).values({ ...eventFields, ip: params.ip, userAgent: params.userAgent, prevHash: null, hash });

    return inserted;
  });

  return { ok: true, ref: newRequest.ref, requestId: newRequest.id };
}
