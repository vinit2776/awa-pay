import { and, desc, eq, sql } from "drizzle-orm";
import { type ScopedTx, withGrantScope } from "@/db/runtime";
import { event, request, requestFile } from "@/db/schema";
import { actorHoldsRole, checkDuplicates, recordDuplicateCheck, type DuplicateMatch, type DuplicateVerdict } from "@/duplicates/duplicateCore";
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
  // The reconsideration flow (phase 11): set when this capture follows a
  // "Reconsider" link on a rejected request. routedApproverId is resolved
  // from that original's own rejection event, not passed in directly —
  // the caller only names which request this one reconsiders.
  linkedRequestId?: string;
  // Set only by an actor who ALSO holds an active super_admin grant (re-
  // verified here, never trusted from the caller) — lifts the
  // application's own blocked_paid warning. Never touches the database's
  // own duplicate constraints, which still apply regardless.
  overrideDuplicate?: { reason: string };
};

export type SubmitRequestResult =
  | { ok: true; ref: string; requestId: string }
  | { ok: false; error: string; duplicate?: { match: DuplicateMatch; verdict: DuplicateVerdict } };

// Resolves who declined the original request, from its own hash-chained
// trail — event.actor on its latest 'request.rejected' row already IS the
// approver who declined it, so this needs no new lookup capability. A
// soft routing hint only (docs/START-HERE-slice-3.md finding #1): if the
// original was never actually rejected (a stale/incorrect link), this
// simply resolves to null and the new request behaves exactly like any
// other — never a hard failure.
async function resolveRoutedApprover(tx: ScopedTx, linkedRequestId: string): Promise<string | null> {
  const [rejectedEvent] = await tx
    .select({ actor: event.actor })
    .from(event)
    .where(and(eq(event.requestId, linkedRequestId), eq(event.type, "request.rejected")))
    .orderBy(desc(event.at))
    .limit(1);
  return rejectedEvent?.actor ?? null;
}

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

  // The advisory duplicate check (phase 11): the only signal available
  // this early is a byte-identical file — no vendor has been matched yet,
  // so the decisive vendor+invoice+FY signal isn't computable until
  // accountRequest. Checked across every attachment; the worst verdict
  // among them wins. Same read-before-write shape payRequest's bank-
  // readiness check already uses — a narrow, accepted race window, not
  // the actual enforcement boundary (that's the database's own unique
  // indexes, unconditionally, at account/pay time).
  let duplicate: { match: DuplicateMatch; verdict: DuplicateVerdict } | null = null;
  for (const attachment of params.attachments) {
    const result = await checkDuplicates(params.userId, "requester", { checksum: attachment.sha256 });
    if (result.verdict !== "none" && result.match) {
      duplicate = { match: result.match, verdict: result.verdict };
      if (result.verdict === "blocked_paid") break;
    }
  }

  let override: { by: string; reason: string } | null = null;
  if (duplicate?.verdict === "blocked_paid") {
    if (!params.overrideDuplicate) {
      return { ok: false, error: "This looks like the same bill as an already-paid request.", duplicate };
    }
    if (!(await actorHoldsRole(params.userId, "super_admin"))) {
      return { ok: false, error: "Only a super admin can override a matched, already-paid bill.", duplicate };
    }
    override = { by: params.userId, reason: params.overrideDuplicate.reason };
  }

  const currency = params.currency ?? "INR";

  const newRequest = await withGrantScope(params.userId, "requester", async (tx) => {
    const routedApproverId = params.linkedRequestId ? await resolveRoutedApprover(tx, params.linkedRequestId) : null;

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
        linkedRequest: params.linkedRequestId,
        routedApproverId,
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

    if (duplicate) {
      await recordDuplicateCheck(tx, inserted.id, duplicate.match, duplicate.verdict, override);
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
        linkedRequestId: params.linkedRequestId ?? null,
        duplicateVerdict: duplicate?.verdict ?? null,
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
