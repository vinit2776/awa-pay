import { and, eq, isNull, sql } from "drizzle-orm";
import { type Role, type ScopedTx, withGrantScope } from "@/db/runtime";
import {
  accounting,
  holdSubReasonEnum,
  payment,
  paymentModeEnum,
  query,
  request,
  requestFile,
  requestStageEnum,
  vendor,
} from "@/db/schema";
import { actorHoldsRole, checkDuplicates, recordDuplicateCheck, type DuplicateMatch, type DuplicateVerdict } from "@/duplicates/duplicateCore";
import { appendEvent } from "@/events/append";
import { formatMinorUnits } from "@/lib/money";
import { headObjectContentLength } from "@/storage/r2";
import { checkPaymentBankReadiness } from "@/vendors/verifyCore";

export type PaymentMode = (typeof paymentModeEnum.enumValues)[number];
export type HoldSubReason = (typeof holdSubReasonEnum.enumValues)[number];

// The one server-side module where "can this person do this to this
// request right now" is answered — per the brief's own infra note. RLS
// (drizzle/migrations/0001_rls_and_grants.sql, amended in 0006) governs
// which rows are visible/writable by role and department/company scope;
// it deliberately does NOT know which stage transitions are legal. This
// module is that gate.
//
// Every transition opens with SELECT ... FOR UPDATE on the request row
// (RLS-filtered — an out-of-scope actor gets zero rows, not an error).
// That lock serializes "read current stage -> validate -> read latest
// event hash -> write" for a given request, which is what makes the
// event hash chain's second link race-free: without it, two concurrent
// transitions on the same request (a double-click, two tabs) could both
// read the same "latest event," compute the same prevHash, and fork the
// chain. drizzle/migrations/0006_desks_rls_and_grants.sql's
// event_request_prev_hash_unique_idx is defense-in-depth on top of this
// lock, not a substitute for it.

type Stage = (typeof requestStageEnum.enumValues)[number];

export type TransitionName =
  | "approve"
  | "returnToRequester"
  | "hold"
  | "reject"
  | "releaseHold"
  | "account"
  | "returnToApprover"
  | "pay"
  | "returnToAccounts"
  | "resubmit"
  | "withdraw"
  | "attachInvoice";

const TRANSITIONS: Record<
  TransitionName,
  { requiredRole: Role; fromStages: Stage[]; toStage: Stage; eventType: string }
> = {
  approve: { requiredRole: "approver", fromStages: ["awaiting_approval"], toStage: "with_accounts", eventType: "request.approved" },
  returnToRequester: { requiredRole: "approver", fromStages: ["awaiting_approval"], toStage: "raised", eventType: "request.returned" },
  hold: { requiredRole: "approver", fromStages: ["awaiting_approval"], toStage: "on_hold", eventType: "request.held" },
  // Spans both awaiting_approval and on_hold: the brief's hold screen
  // offers "convert to a reject" as one of hold's own exits.
  reject: { requiredRole: "approver", fromStages: ["awaiting_approval", "on_hold"], toStage: "rejected", eventType: "request.rejected" },
  releaseHold: { requiredRole: "approver", fromStages: ["on_hold"], toStage: "awaiting_approval", eventType: "request.hold_released" },
  account: { requiredRole: "accountant", fromStages: ["with_accounts"], toStage: "to_pay", eventType: "request.accounted" },
  returnToApprover: { requiredRole: "accountant", fromStages: ["with_accounts"], toStage: "awaiting_approval", eventType: "request.returned_to_approver" },
  pay: { requiredRole: "payer", fromStages: ["to_pay"], toStage: "paid", eventType: "request.paid" },
  returnToAccounts: { requiredRole: "payer", fromStages: ["to_pay"], toStage: "with_accounts", eventType: "request.returned_to_accounts" },
  resubmit: { requiredRole: "requester", fromStages: ["raised"], toStage: "awaiting_approval", eventType: "request.resubmitted" },
  withdraw: { requiredRole: "requester", fromStages: ["raised"], toStage: "withdrawn", eventType: "request.withdrawn" },
  // An advance stays open after its money has moved, waiting on the tax
  // invoice. The requester attaches it, which puts the balance in the
  // payer's queue. fromStages stays inside request_update's requester
  // branch (0024) — see the load-bearing note in runTransition.
  attachInvoice: { requiredRole: "requester", fromStages: ["awaiting_invoice"], toStage: "to_pay", eventType: "request.invoice_attached" },
};

export type TransitionResult =
  | { ok: true }
  | { ok: false; error: string; duplicate?: { match: DuplicateMatch; verdict: DuplicateVerdict } };

type Meta = { ip: string; userAgent: string | undefined };

type RequestRow = typeof request.$inferSelect;

async function runTransition(
  actorId: string,
  name: TransitionName,
  requestId: string,
  meta: Meta,
  reason: string | null,
  patch:
    | Partial<typeof request.$inferInsert>
    | ((tx: ScopedTx, req: RequestRow) => Partial<typeof request.$inferInsert> | Promise<Partial<typeof request.$inferInsert>>),
  buildAfter: (
    tx: ScopedTx,
    req: RequestRow,
  ) => Promise<{ objectType: string; objectId: string; after: Record<string, unknown>; eventType?: string }>,
): Promise<TransitionResult> {
  const spec = TRANSITIONS[name];

  return withGrantScope(actorId, spec.requiredRole, async (tx) => {
    // Plain SELECT ... FOR UPDATE works here specifically because every
    // requester-role transition (resubmit, withdraw) only ever has
    // fromStages: ["raised"] — which always coincides with
    // request_update's own requester branch requiring stage = 'raised'
    // (0006_desks_rls_and_grants.sql). That coincidence is load-bearing:
    // Postgres row-locking clauses require the row to satisfy an
    // applicable UPDATE policy, not just the SELECT policy, so a
    // requester-role FOR UPDATE on a request NOT in 'raised' stage
    // silently returns zero rows — no error, the lock just quietly does
    // nothing. Traced and fixed in src/requests/lock.ts's
    // lockRequestMutex (an advisory lock, RLS-independent) for
    // src/conversation/{queries,nudges}Core.ts, which need the same
    // per-request mutex from roles/stages this coincidence doesn't cover.
    // Don't widen any requester transition's fromStages beyond ["raised"]
    // without re-checking this.
    const [req] = await tx.select().from(request).where(eq(request.id, requestId)).for("update");
    if (!req) {
      return { ok: false, error: "Request not found." };
    }

    // A query freezes a request in place regardless of what's being
    // attempted — uniformly across every transition, resubmit and
    // withdraw included, since a query can legitimately be raised at any
    // stage a request passes through. Checked before the stage-legality
    // check below so the error a caller sees names the actual blocker.
    const [openQuery] = await tx
      .select({ id: query.id })
      .from(query)
      .where(and(eq(query.requestId, req.id), isNull(query.resolvedAt)))
      .limit(1);
    if (openQuery) {
      return { ok: false, error: "This request has an open query — answer it before continuing." };
    }

    if (!spec.fromStages.includes(req.stage)) {
      return { ok: false, error: `This request is no longer in a stage "${name}" can act on.` };
    }

    const resolvedPatch = typeof patch === "function" ? await patch(tx, req) : patch;

    // Deliberately one UPDATE, not two. request_update's RLS policy (for
    // the requester role specifically) requires stage = 'raised' in its
    // USING clause — if this set stage first and buildAfter ran a second,
    // separate UPDATE afterward (e.g. resubmit's revision bump), that
    // second statement's row would already be invisible under the new
    // stage and would silently affect zero rows. Any field a transition
    // needs to change belongs in this single combined SET.
    await tx
      .update(request)
      .set({ stage: spec.toStage, ...resolvedPatch, updatedAt: new Date() })
      .where(eq(request.id, req.id));

    const { objectType, objectId, after, eventType } = await buildAfter(tx, req);

    const selfActioned = actorId === req.raisedBy;
    await appendEvent(
      tx,
      {
        requestId: req.id,
        actor: actorId,
        roleAtTime: spec.requiredRole,
        type: eventType ?? spec.eventType,
        objectType,
        objectId,
        before: { stage: req.stage },
        after: { ...after, selfActioned },
        reason,
      },
      meta,
    );

    return { ok: true };
  });
}

export type PaymentCycle = "unspecified" | "immediate" | "dated";

export type AttachInvoiceParams = {
  invoiceNo: string;
  invoiceDate: string;
  amountMinor: number;
  attachments: ResubmitAttachment[];
};

// The second half of an advance: the vendor's tax invoice has arrived and
// the requester who raised the advance attaches it. The request's amount
// becomes the real invoice total, and the request returns to the payer's
// queue for the balance (invoice total less what the advance already paid).
export async function attachInvoice(
  actorId: string,
  requestId: string,
  params: AttachInvoiceParams,
  meta: Meta,
): Promise<TransitionResult> {
  if (!params.invoiceNo.trim()) return { ok: false, error: "Enter the invoice number." };
  if (!params.invoiceDate) return { ok: false, error: "Enter the invoice date." };
  if (params.amountMinor <= 0) return { ok: false, error: "Enter a valid amount." };
  if (params.attachments.length === 0) return { ok: false, error: "Attach a photo or PDF of the invoice." };

  // Same ownership check withdrawRequest makes: request_update's requester
  // branch is department-pool-wide, so raisedBy is what actually limits
  // this to the person who raised the advance.
  const [req] = await withGrantScope(actorId, "requester", (tx) => tx.select().from(request).where(eq(request.id, requestId)));
  if (!req) return { ok: false, error: "Request not found." };
  if (req.raisedBy !== actorId) return { ok: false, error: "Only the requester who raised this can attach its invoice." };
  if (req.kind !== "advance") return { ok: false, error: "Only an advance is waiting for an invoice." };

  for (const attachment of params.attachments) {
    const actualLength = await headObjectContentLength(attachment.storageKey);
    if (actualLength === null || actualLength !== attachment.byteLength) {
      return { ok: false, error: "One of the uploaded files could not be verified. Please try again." };
    }
  }

  try {
    return await runTransition(
      actorId,
      "attachInvoice",
      requestId,
      meta,
      null,
      async (tx, locked) => {
        const settled = await sumSettledMinor(tx, locked.id);
        if (params.amountMinor < settled) {
          throw new LedgerRejection(
            `The invoice is ${formatMinorUnits(params.amountMinor, locked.currency)}, less than the ${formatMinorUnits(settled, locked.currency)} already paid as an advance. Tell accounts — the vendor may owe a refund.`,
          );
        }
        return {
          invoiceNo: params.invoiceNo.trim(),
          invoiceDate: params.invoiceDate,
          amountMinor: params.amountMinor,
          invoiceAttachedAt: new Date(),
          // The advance can't have been asked for at more than the invoice
          // it turned out to be (request_pay_now_within_total_check).
          payNowMinor: Math.min(locked.payNowMinor ?? params.amountMinor, params.amountMinor),
        };
      },
      async (tx, locked) => {
        const existingCount = await tx.$count(requestFile, and(eq(requestFile.requestId, locked.id), eq(requestFile.kind, "bill")));
        for (const [i, attachment] of params.attachments.entries()) {
          await tx.insert(requestFile).values({
            id: attachment.fileId,
            requestId: locked.id,
            kind: "bill",
            storageKey: attachment.storageKey,
            pageNo: existingCount + i + 1,
            mime: attachment.mime,
            bytes: attachment.byteLength,
            sha256: attachment.sha256,
            uploadedBy: actorId,
          });
        }
        return {
          objectType: "request",
          objectId: locked.id,
          after: {
            invoiceNo: params.invoiceNo.trim(),
            invoiceDate: params.invoiceDate,
            amountMinor: params.amountMinor,
            quotedAmountMinor: locked.amountMinor,
            fileCount: params.attachments.length,
          },
        };
      },
    );
  } catch (err) {
    if (err instanceof LedgerRejection) return { ok: false, error: err.message };
    throw err;
  }
}

export async function approveRequest(
  actorId: string,
  requestId: string,
  params: { cycle: PaymentCycle; dueDate: string | null; noteToAccountsAndPayer: string | null },
  meta: Meta,
): Promise<TransitionResult> {
  return runTransition(
    actorId,
    "approve",
    requestId,
    meta,
    null,
    { note: params.noteToAccountsAndPayer, dueDate: params.cycle === "dated" ? params.dueDate : null },
    async () => ({
      objectType: "request",
      objectId: requestId,
      after: { cycle: params.cycle, dueDate: params.dueDate, noteToAccountsAndPayer: params.noteToAccountsAndPayer },
    }),
  );
}

export async function returnRequestToRequester(
  actorId: string,
  requestId: string,
  params: { reason: string },
  meta: Meta,
): Promise<TransitionResult> {
  if (!params.reason.trim()) return { ok: false, error: "A reason is required." };
  return runTransition(
    actorId,
    "returnToRequester",
    requestId,
    meta,
    params.reason,
    { closeReason: null, holdReviewOn: null, holdSubReason: null, dueDate: null },
    async (_tx, req) => ({ objectType: "request", objectId: requestId, after: { revision: req.revision, reason: params.reason } }),
  );
}

export async function holdRequest(
  actorId: string,
  requestId: string,
  params: { reviewOn: string; subReason: HoldSubReason; reason: string },
  meta: Meta,
): Promise<TransitionResult> {
  if (!params.reviewOn) return { ok: false, error: "A review date is required." };
  if (!params.reason.trim()) return { ok: false, error: "A reason is required." };
  return runTransition(
    actorId,
    "hold",
    requestId,
    meta,
    params.reason,
    { holdReviewOn: params.reviewOn, holdSubReason: params.subReason, closeReason: params.reason },
    async () => ({
      objectType: "request",
      objectId: requestId,
      after: { reviewOn: params.reviewOn, subReason: params.subReason, reason: params.reason },
    }),
  );
}

export async function rejectRequest(
  actorId: string,
  requestId: string,
  params: { reason: string },
  meta: Meta,
): Promise<TransitionResult> {
  if (!params.reason.trim()) return { ok: false, error: "A reason is required." };
  return runTransition(
    actorId,
    "reject",
    requestId,
    meta,
    params.reason,
    { closeReason: params.reason },
    async () => ({ objectType: "request", objectId: requestId, after: { reason: params.reason } }),
  );
}

export async function releaseHold(actorId: string, requestId: string, meta: Meta): Promise<TransitionResult> {
  return runTransition(actorId, "releaseHold", requestId, meta, null, { holdReviewOn: null, holdSubReason: null, closeReason: null }, async () => ({
    objectType: "request",
    objectId: requestId,
    after: {},
  }));
}

export async function accountRequest(
  actorId: string,
  requestId: string,
  params: {
    companyId: string;
    vendorId: string;
    headId: string;
    voucherNo: string;
    bookedOn: string;
    overrideDuplicate?: { reason: string };
  },
  meta: Meta,
): Promise<TransitionResult> {
  if (!params.voucherNo.trim()) return { ok: false, error: "A voucher number is required." };
  if (!params.vendorId) return { ok: false, error: "A vendor is required." };

  // The decisive duplicate check (phase 11): this is the FIRST moment
  // vendor+invoice+FY is computable at all — invoiceKey/fy already exist
  // on the request row (generated at capture), but vendor_key only lands
  // once a vendor is actually matched, which is what this very transition
  // is about to do. A read-before-write pre-check, same shape as
  // payRequest's own bank-readiness gate — the narrow race window it
  // accepts is not the real enforcement boundary; request's own
  // one_payment_per_invoice partial unique index is.
  const [current] = await withGrantScope(actorId, "accountant", (tx) =>
    tx.select({ invoiceKey: request.invoiceKey, fy: request.fy }).from(request).where(eq(request.id, requestId)).limit(1),
  );
  const [matchedVendorForCheck] = await withGrantScope(actorId, "accountant", (tx) =>
    tx.select({ vendorKey: vendor.vendorKey }).from(vendor).where(eq(vendor.id, params.vendorId)).limit(1),
  );

  const duplicateResult =
    current?.invoiceKey && current.fy && matchedVendorForCheck?.vendorKey
      ? await checkDuplicates(actorId, "accountant", {
          excludeRequestId: requestId,
          vendorKey: matchedVendorForCheck.vendorKey,
          invoiceKey: current.invoiceKey,
          fy: current.fy,
        })
      : { verdict: "none" as const, match: null };

  let override: { by: string; reason: string } | null = null;
  if (duplicateResult.verdict === "blocked_paid" && duplicateResult.match) {
    if (!params.overrideDuplicate) {
      return { ok: false, error: "This vendor and invoice number were already paid on another request.", duplicate: { match: duplicateResult.match, verdict: duplicateResult.verdict } };
    }
    if (!(await actorHoldsRole(actorId, "super_admin"))) {
      return { ok: false, error: "Only a super admin can override an already-paid vendor+invoice match.", duplicate: { match: duplicateResult.match, verdict: duplicateResult.verdict } };
    }
    override = { by: actorId, reason: params.overrideDuplicate.reason };
  }

  return runTransition(
    actorId,
    "account",
    requestId,
    meta,
    null,
    // vendorKey is resolved from the matched vendor's own generated
    // column, not recomputed here — it must land in this same combined
    // UPDATE (see runTransition's own comment on why one UPDATE, not two).
    async (tx: ScopedTx) => {
      const [matchedVendor] = await tx.select({ vendorKey: vendor.vendorKey }).from(vendor).where(eq(vendor.id, params.vendorId)).limit(1);
      if (!matchedVendor) {
        throw new Error("Vendor not found.");
      }
      return { companyId: params.companyId, vendorKey: matchedVendor.vendorKey } satisfies Partial<typeof request.$inferInsert>;
    },
    async (tx) => {
      const [row] = await tx
        .insert(accounting)
        .values({
          requestId,
          companyId: params.companyId,
          vendorId: params.vendorId,
          headId: params.headId,
          voucherNo: params.voucherNo,
          bookedOn: params.bookedOn,
          accountedBy: actorId,
        })
        .returning({ id: accounting.id });

      if (duplicateResult.match) {
        await recordDuplicateCheck(tx, requestId, duplicateResult.match, duplicateResult.verdict, override);
      }

      return {
        objectType: "accounting",
        objectId: row.id,
        after: { companyId: params.companyId, vendorId: params.vendorId, headId: params.headId, voucherNo: params.voucherNo, bookedOn: params.bookedOn },
      };
    },
  );
}

export async function returnToApprover(
  actorId: string,
  requestId: string,
  params: { reason: string },
  meta: Meta,
): Promise<TransitionResult> {
  if (!params.reason.trim()) return { ok: false, error: "A reason is required." };
  return runTransition(actorId, "returnToApprover", requestId, meta, params.reason, {}, async () => ({
    objectType: "request",
    objectId: requestId,
    after: { reason: params.reason },
  }));
}

export type FromAccount = { id: string; label: string; bankName: string; accountNumber: string; ifsc: string };

export type AdviceAttachment = { fileId: string; storageKey: string; mime: string; byteLength: number; sha256: string };

export async function payRequest(
  actorId: string,
  requestId: string,
  params: {
    fromAccount: FromAccount;
    mode: PaymentMode;
    valueDate: string;
    amountMinor: number;
    tdsMinor: number;
    reference: string;
    advice?: AdviceAttachment;
  },
  meta: Meta,
): Promise<TransitionResult> {
  if (!params.reference.trim()) return { ok: false, error: "A payment reference is required." };
  if (params.amountMinor <= 0) return { ok: false, error: "Enter a valid amount." };
  if (params.tdsMinor < 0) return { ok: false, error: "TDS cannot be negative." };

  // The payer-verification gate (phase 10). One live read, no per-request
  // cached flag — checkPaymentBankReadiness resolves the vendor's CURRENT
  // bank row fresh on every call, which is the entire mechanism behind "a
  // bank change flags every open request for this vendor": the moment any
  // vendor_bank row is superseded, the new row's verified_at starts null,
  // so the very next payRequest attempt on ANY open request for that
  // vendor re-triggers this gate automatically — see
  // src/vendors/verifyCore.ts. Checked before the row lock below, same as
  // the advice-file corroboration right after it — a narrow, accepted race
  // window (the same shape that check already lives with), not the actual
  // enforcement boundary (that's the RLS-gated UPDATE itself).
  const readiness = await checkPaymentBankReadiness(actorId, requestId);
  if (!readiness.ready) {
    if (readiness.reason === "no_vendor") {
      return { ok: false, error: "This request has no accounted vendor — return it to accounts." };
    }
    if (readiness.reason === "no_bank") {
      return { ok: false, error: `No bank details are on file for ${readiness.vendorName} — add bank details before paying.` };
    }
    return { ok: false, error: `${readiness.vendorName}'s bank details haven't been verified yet — verify them before paying.` };
  }

  // Same server-side corroboration captureCore.ts uses for a bill's
  // attachment — before opening any transaction, not after.
  if (params.advice) {
    const actualLength = await headObjectContentLength(params.advice.storageKey);
    if (actualLength === null || actualLength !== params.advice.byteLength) {
      return { ok: false, error: "The advice file could not be verified. Please try again." };
    }
  }

  // The two structural, unbypassable duplicate guarantees (phase 11) both
  // fire somewhere in the transaction this call opens: request's own
  // one_payment_per_invoice partial unique index, on the combined UPDATE
  // that flips stage to 'paid' (inside runTransition itself), and
  // payment.reference's now-case-insensitive unique index, on the INSERT
  // below. Neither has an application-layer check ahead of it the way the
  // advisory capture/account checks do — these are the real enforcement
  // boundary, so a caught violation here is the expected, only path to a
  // graceful error, not a fallback for a check that already ran.
  try {
    // Filled by the patch callback below, read by buildAfter: the ledger
    // arithmetic is done once, under the row lock runTransition takes, and
    // both callbacks see the same numbers.
    let outcome: { settledBefore: number; settledAfter: number; balance: number; eventType: string } | null = null;

    return await runTransition(
      actorId,
      "pay",
      requestId,
      meta,
      null,
      async (tx, req) => {
        const settledBefore = await sumSettledMinor(tx, req.id);
        const settledAfter = settledBefore + params.amountMinor;

        // The ceiling that replaced "exactly one payment per request".
        if (settledAfter > req.amountMinor) {
          throw new LedgerRejection(
            `That would take payments to ${formatMinorUnits(settledAfter, req.currency)}, above the ${formatMinorUnits(req.amountMinor, req.currency)} this request can settle. The balance is ${formatMinorUnits(req.amountMinor - settledBefore, req.currency)}.`,
          );
        }

        // An advance approved for a stated amount can't quietly become a
        // larger one before the tax invoice is in (concept-v2.html section
        // 09: "the exposure cap for this request").
        const invoiceIsIn = req.kind !== "advance" || req.invoiceAttachedAt !== null;
        if (!invoiceIsIn && req.payNowMinor !== null && settledAfter > req.payNowMinor) {
          throw new LedgerRejection(
            `This advance was asked for at ${formatMinorUnits(req.payNowMinor, req.currency)}. Paying more than that needs the tax invoice attached first.`,
          );
        }

        const balance = req.amountMinor - settledAfter;
        const stage: Stage = !invoiceIsIn ? "awaiting_invoice" : balance === 0 ? "paid" : "to_pay";
        outcome = {
          settledBefore,
          settledAfter,
          balance,
          eventType: stage === "paid" ? "request.paid" : stage === "awaiting_invoice" ? "request.advance_paid" : "request.part_paid",
        };
        return { stage };
      },
      async (tx) => {
        const [row] = await tx
          .insert(payment)
          .values({
            requestId,
            fromAccount: params.fromAccount,
            mode: params.mode,
            valueDate: params.valueDate,
            amountMinor: params.amountMinor,
            tdsMinor: params.tdsMinor,
            reference: params.reference,
            paidBy: actorId,
          })
          .returning({ id: payment.id });

        if (params.advice) {
          await tx.insert(requestFile).values({
            id: params.advice.fileId,
            requestId,
            kind: "payment_advice",
            storageKey: params.advice.storageKey,
            mime: params.advice.mime,
            bytes: params.advice.byteLength,
            sha256: params.advice.sha256,
            uploadedBy: actorId,
          });
        }

        // runTransition awaits the patch callback before this one, so the
        // ledger numbers are always set by now.
        const settled = outcome!;
        return {
          objectType: "payment",
          objectId: row.id,
          eventType: settled.eventType,
          after: {
            mode: params.mode,
            valueDate: params.valueDate,
            amountMinor: params.amountMinor,
            tdsMinor: params.tdsMinor,
            reference: params.reference,
            fromAccountLabel: params.fromAccount.label,
            hasAdvice: Boolean(params.advice),
            settledBeforeMinor: settled.settledBefore,
            settledAfterMinor: settled.settledAfter,
            balanceMinor: settled.balance,
          },
        };
      },
    );
  } catch (err) {
    if (err instanceof LedgerRejection) return { ok: false, error: err.message };
    const constraint = uniqueViolationConstraint(err);
    if (constraint === "payment_reference_unique_idx") {
      return { ok: false, error: "This payment reference has already been used on another payment." };
    }
    if (constraint === "one_payment_per_invoice") {
      return { ok: false, error: "This vendor and invoice number were already paid on another request." };
    }
    throw err;
  }
}

// Thrown from inside a transition's patch callback to abandon it with a
// message the desk can act on; the surrounding transaction rolls back, so
// nothing has been written by then. Never escapes this module.
class LedgerRejection extends Error {}

// Money already applied to a request, in minor units. Gross amounts (the
// payment's own amount_minor); TDS is a deduction inside that figure, not
// an addition to it. Called under the request-row lock, so the sum and the
// INSERT that follows can't be interleaved with another payment.
async function sumSettledMinor(tx: ScopedTx, requestId: string): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${payment.amountMinor}), 0)::text` })
    .from(payment)
    .where(eq(payment.requestId, requestId));
  return Number(row?.total ?? 0);
}

// Postgres error code for a unique-constraint violation, plus which
// constraint — src/vendors/vendorsCore.ts's own isUniqueViolation found
// that drizzle-orm's postgres-js driver's error shape varies by query
// style (raw `.code` for some, `.cause.code` for others); check both
// here too rather than assume one.
function uniqueViolationConstraint(err: unknown): string | null {
  const direct = err && typeof err === "object" ? (err as { code?: unknown; constraint_name?: unknown }) : null;
  if (direct?.code === "23505" && typeof direct.constraint_name === "string") return direct.constraint_name;
  const cause = err && typeof err === "object" && "cause" in err ? (err as { cause?: unknown }).cause : null;
  const causeRecord = cause && typeof cause === "object" ? (cause as { code?: unknown; constraint_name?: unknown }) : null;
  if (causeRecord?.code === "23505" && typeof causeRecord.constraint_name === "string") return causeRecord.constraint_name;
  return null;
}

export async function returnToAccounts(
  actorId: string,
  requestId: string,
  params: { reason: string },
  meta: Meta,
): Promise<TransitionResult> {
  if (!params.reason.trim()) return { ok: false, error: "A reason is required." };
  return runTransition(actorId, "returnToAccounts", requestId, meta, params.reason, {}, async () => ({
    objectType: "request",
    objectId: requestId,
    after: { reason: params.reason },
  }));
}

export type ResubmitAttachment = { fileId: string; storageKey: string; mime: string; byteLength: number; sha256: string };

export async function resubmitRequest(
  actorId: string,
  requestId: string,
  params: {
    amountMinor: number;
    invoiceNo?: string;
    invoiceDate?: string;
    vendor?: string;
    note?: string;
    newAttachments: ResubmitAttachment[];
  },
  meta: Meta,
): Promise<TransitionResult> {
  if (params.amountMinor <= 0) return { ok: false, error: "Enter a valid amount." };

  return runTransition(
    actorId,
    "resubmit",
    requestId,
    meta,
    null,
    // A function, not a static object, because the revision bump depends
    // on the row's own current value (read under the row lock above).
    // It must land in runTransition's single combined UPDATE — a second,
    // separate UPDATE here would run after stage has already flipped to
    // 'awaiting_approval', and request_update's RLS policy only grants
    // the requester role write access while stage = 'raised', so that
    // second statement would silently touch zero rows.
    (_tx, req) => ({
      amountMinor: params.amountMinor,
      invoiceNo: params.invoiceNo,
      invoiceDate: params.invoiceDate,
      vendor: params.vendor,
      note: params.note,
      revision: req.revision + 1,
    }),
    async (tx, req) => {
      if (params.newAttachments.length > 0) {
        const existingCount = await tx.$count(requestFile, and(eq(requestFile.requestId, req.id), eq(requestFile.kind, "bill")));
        for (const [i, attachment] of params.newAttachments.entries()) {
          await tx.insert(requestFile).values({
            id: attachment.fileId,
            requestId: req.id,
            kind: "bill",
            storageKey: attachment.storageKey,
            pageNo: existingCount + i + 1,
            mime: attachment.mime,
            bytes: attachment.byteLength,
            sha256: attachment.sha256,
            uploadedBy: actorId,
          });
        }
      }

      return {
        objectType: "request",
        objectId: req.id,
        after: { revision: req.revision + 1, amountMinor: params.amountMinor, newFileCount: params.newAttachments.length },
      };
    },
  );
}

export async function withdrawRequest(actorId: string, requestId: string, meta: Meta): Promise<TransitionResult> {
  // Mirrors resubmitCore.ts's ownership check exactly: request_update's
  // RLS policy for the requester role is department-pool-wide while
  // stage = 'raised' (any requester in the department, not just the one
  // who raised it) — the raisedBy check below is what actually restricts
  // withdrawal to the person who raised the request.
  const [req] = await withGrantScope(actorId, "requester", (tx) => tx.select().from(request).where(eq(request.id, requestId)));
  if (!req) {
    return { ok: false, error: "Request not found." };
  }
  if (req.raisedBy !== actorId) {
    return { ok: false, error: "Only the requester who raised this can withdraw it." };
  }

  return runTransition(actorId, "withdraw", requestId, meta, null, { closeReason: "Withdrawn by requester" }, async () => ({
    objectType: "request",
    objectId: requestId,
    after: {},
  }));
}
