import { and, desc, eq, sql } from "drizzle-orm";
import { type ScopedTx, withGrantScope } from "@/db/runtime";
import { event, request, requestFile } from "@/db/schema";
import { actorHoldsRoleInTx, checkDuplicatesInTx, recordDuplicateCheck, type DuplicateMatch, type DuplicateVerdict } from "@/duplicates/duplicateCore";
import { computeEventHash } from "@/events/hash";
import { attachExtractionToRequest } from "@/extraction/extractCore";
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
  gstinOnBill?: string;
  note?: string;
  attachments: Attachment[];
  // Set whenever the capture screen ran extraction against the first
  // attachment before this call (phase 13) — present whether that attempt
  // succeeded OR failed. attemptId ties this submission back to the
  // attempt's own extraction rows (already written, before this request
  // existed at all); phash was computed from the same bytes and is
  // applied to that attachment's request_file row here, its only durable
  // home. Backfilling request_id even on a failed attempt is deliberate:
  // it's what distinguishes "completed by hand" from "abandoned" for the
  // health console's abandonment-rate metric (docs/START-HERE-slice-4.md)
  // — an attempt that never gets a request_id at all is the one that was
  // actually abandoned.
  extraction?: { attemptId: string; phash: string | null };
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
  // doesn't match what R2 actually received. Independent network calls, so
  // concurrent rather than one after another.
  const lengths = await Promise.all(params.attachments.map((a) => headObjectContentLength(a.storageKey)));
  if (params.attachments.some((a, i) => lengths[i] === null || lengths[i] !== a.byteLength)) {
    return { ok: false, error: "One of the uploaded files could not be verified. Please try again." };
  }

  const currency = params.currency ?? "INR";

  const outcome = await withGrantScope(params.userId, "requester", async (tx) => {
    // The advisory duplicate check (phase 11): the only signal available
    // this early is a byte-identical file — no vendor has been matched yet,
    // so the decisive vendor+invoice+FY signal isn't computable until
    // accountRequest. Checked across every attachment; the worst verdict
    // among them wins. Same read-before-write shape payRequest's bank-
    // readiness check already uses — a narrow, accepted race window, not
    // the actual enforcement boundary (that's the database's own unique
    // indexes, unconditionally, at account/pay time). Runs in the same
    // transaction as the insert it guards, rather than in transactions of
    // its own before it (one per attachment, plus one for the super-admin
    // check): each of those was a full scope setup plus commit.
    let duplicate: { match: DuplicateMatch; verdict: DuplicateVerdict } | null = null;
    for (const attachment of params.attachments) {
      const result = await checkDuplicatesInTx(tx, { checksum: attachment.sha256 });
      if (result.verdict !== "none" && result.match) {
        duplicate = { match: result.match, verdict: result.verdict };
        if (result.verdict === "blocked_paid") break;
      }
    }

    let override: { by: string; reason: string } | null = null;
    if (duplicate?.verdict === "blocked_paid") {
      if (!params.overrideDuplicate) {
        return { kind: "blocked" as const, result: { ok: false as const, error: "This looks like the same bill as an already-paid request.", duplicate } };
      }
      if (!(await actorHoldsRoleInTx(tx, params.userId, "super_admin"))) {
        return { kind: "blocked" as const, result: { ok: false as const, error: "Only a super admin can override a matched, already-paid bill.", duplicate } };
      }
      override = { by: params.userId, reason: params.overrideDuplicate.reason };
    }

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
        gstinOnBill: params.gstinOnBill,
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
        // Extraction only ever runs against the first attachment (see
        // CaptureForm.tsx) — its phash, if one was computed, belongs on
        // that same page's own row.
        phash: i === 0 ? (params.extraction?.phash ?? null) : null,
        uploadedBy: params.userId,
      });
    }

    if (duplicate) {
      await recordDuplicateCheck(tx, inserted.id, duplicate.match, duplicate.verdict, override);
    }

    const extractionSummary = params.extraction
      ? await attachExtractionToRequest(tx, params.extraction.attemptId, inserted.id, params.userId, {
          vendor: params.vendor ?? null,
          amountMajor: params.amountMinor / 100,
          invoiceNo: params.invoiceNo ?? null,
          invoiceDate: params.invoiceDate ?? null,
          gstin: params.gstinOnBill ?? null,
        })
      : null;

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
        gstinOnBill: params.gstinOnBill ?? null,
        note: params.note ?? null,
        fileCount: params.attachments.length,
        stage: "raised",
        linkedRequestId: params.linkedRequestId ?? null,
        duplicateVerdict: duplicate?.verdict ?? null,
        // Compact summary only — the full per-field value/confidence/
        // correction detail lives in the extraction table itself (see
        // attachExtractionToRequest), same split duplicateVerdict above
        // already uses against the fuller duplicate_check row.
        extraction: extractionSummary,
      },
      reason: null,
    };
    // request.raised is always the first event a new request gets, so
    // prevHash is unambiguously null here — see src/events/hash.ts.
    const hash = computeEventHash(eventFields, null);

    await tx.insert(event).values({ ...eventFields, ip: params.ip, userAgent: params.userAgent, prevHash: null, hash });

    return { kind: "inserted" as const, inserted };
  });

  if (outcome.kind === "blocked") return outcome.result;
  return { ok: true, ref: outcome.inserted.ref, requestId: outcome.inserted.id };
}
