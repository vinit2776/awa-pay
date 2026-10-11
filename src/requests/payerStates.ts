import { and, eq, isNull } from "drizzle-orm";
import { type Role, type ScopedTx, withGrantScope } from "@/db/runtime";
import { query, request, requestFlag } from "@/db/schema";
import { appendEvent, type Meta } from "@/events/append";
import { lockRequestMutex } from "./lock";
import { resolveViewerRole } from "./viewerRole";

// Two things a desk can do to a request without moving it.
//
// 1. The payer's working state inside to_pay: mark a payment in progress
//    (started at the bank, no UTR yet) or hold it (funds, a frozen account).
//    Neither changes the stage, which still names the payer as owner, so
//    these deliberately don't go through runTransition (no fromStages /
//    toStage to validate). request_payer_state_shape_check (0026) is the
//    database-level guarantee; the checks here exist to give the payer a
//    sentence instead of a constraint error.
// 2. A manual flag, which any of the three desks can raise and clear.
//
// Both take the per-request advisory mutex (lock.ts) first, so they can't
// interleave with a transition or each other, and both commit their audit
// event in the same transaction as the change (AGENTS.md rule 3).

export type PayerStateResult = { ok: true } | { ok: false; error: string };

const PAYER: Role = "payer";

type Current = typeof request.$inferSelect;

async function loadForPayerChange(tx: ScopedTx, requestId: string): Promise<{ ok: true; req: Current } | { ok: false; error: string }> {
  await lockRequestMutex(tx, requestId);
  const [req] = await tx.select().from(request).where(eq(request.id, requestId)).limit(1);
  if (!req) return { ok: false, error: "Request not found." };
  if (req.stage !== "to_pay") return { ok: false, error: "This request is no longer with the payer." };

  // A query freezes a request in place, and that includes the payer's own
  // working state: the same rule runTransition applies to every move.
  const [openQuery] = await tx
    .select({ id: query.id })
    .from(query)
    .where(and(eq(query.requestId, requestId), isNull(query.resolvedAt)))
    .limit(1);
  if (openQuery) return { ok: false, error: "This request has an open query — answer it before continuing." };
  return { ok: true, req };
}

async function record(tx: ScopedTx, actorId: string, req: Current, type: string, after: Record<string, unknown>, reason: string | null, meta: Meta) {
  await appendEvent(
    tx,
    {
      requestId: req.id,
      actor: actorId,
      roleAtTime: PAYER,
      type,
      objectType: "request",
      objectId: req.id,
      before: { stage: req.stage, payerState: req.payerState },
      after: { ...after, selfActioned: actorId === req.raisedBy },
      reason,
    },
    meta,
  );
}

export async function markPaymentInProgress(actorId: string, requestId: string, params: { note?: string }, meta: Meta): Promise<PayerStateResult> {
  return withGrantScope(actorId, PAYER, async (tx) => {
    const loaded = await loadForPayerChange(tx, requestId);
    if (!loaded.ok) return loaded;
    const { req } = loaded;
    if (req.payerState === "in_progress") return { ok: false, error: "This payment is already marked in progress." };
    if (req.payerState === "on_hold") return { ok: false, error: "You put this request on hold. Release the hold first." };

    const note = params.note?.trim() || null;
    await tx
      .update(request)
      .set({ payerState: "in_progress", payerStateReason: note, payerReviewOn: null, payerStateAt: new Date(), payerStateBy: actorId, updatedAt: new Date() })
      .where(eq(request.id, requestId));
    await record(tx, actorId, req, "request.payment_in_progress", { note }, note, meta);
    return { ok: true };
  });
}

// For a payment that failed or was abandoned at the bank. Recording the
// payment itself clears the mark (transitions.ts), so this is only the
// "it didn't go through" exit.
export async function clearPaymentInProgress(actorId: string, requestId: string, meta: Meta): Promise<PayerStateResult> {
  return withGrantScope(actorId, PAYER, async (tx) => {
    const loaded = await loadForPayerChange(tx, requestId);
    if (!loaded.ok) return loaded;
    const { req } = loaded;
    if (req.payerState !== "in_progress") return { ok: false, error: "This payment is not marked in progress." };

    await clearState(tx, requestId);
    await record(tx, actorId, req, "request.payment_in_progress_cleared", {}, null, meta);
    return { ok: true };
  });
}

export async function holdAsPayer(actorId: string, requestId: string, params: { reason: string; reviewOn: string }, meta: Meta): Promise<PayerStateResult> {
  const reason = params.reason.trim();
  if (!reason) return { ok: false, error: "A reason is required." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.reviewOn)) return { ok: false, error: "A review date is required." };

  return withGrantScope(actorId, PAYER, async (tx) => {
    const loaded = await loadForPayerChange(tx, requestId);
    if (!loaded.ok) return loaded;
    const { req } = loaded;
    if (req.payerState === "in_progress") return { ok: false, error: "A payment is marked in progress. Record it, or clear the mark, before holding." };
    if (req.payerState === "on_hold") return { ok: false, error: "This request is already on hold." };

    await tx
      .update(request)
      .set({ payerState: "on_hold", payerStateReason: reason, payerReviewOn: params.reviewOn, payerStateAt: new Date(), payerStateBy: actorId, updatedAt: new Date() })
      .where(eq(request.id, requestId));
    await record(tx, actorId, req, "request.payer_held", { reviewOn: params.reviewOn, reason }, reason, meta);
    return { ok: true };
  });
}

export async function releasePayerHold(actorId: string, requestId: string, meta: Meta): Promise<PayerStateResult> {
  return withGrantScope(actorId, PAYER, async (tx) => {
    const loaded = await loadForPayerChange(tx, requestId);
    if (!loaded.ok) return loaded;
    const { req } = loaded;
    if (req.payerState !== "on_hold") return { ok: false, error: "This request is not on hold." };

    await clearState(tx, requestId);
    await record(tx, actorId, req, "request.payer_hold_released", {}, null, meta);
    return { ok: true };
  });
}

async function clearState(tx: ScopedTx, requestId: string) {
  await tx
    .update(request)
    .set({ payerState: null, payerStateReason: null, payerReviewOn: null, payerStateAt: null, payerStateBy: null, updatedAt: new Date() })
    .where(eq(request.id, requestId));
}

export const FLAG_ROLES: Role[] = ["approver", "accountant", "payer"];

export type FlagResult = { ok: true } | { ok: false; error: string };

// Unlike the payer state, a flag is allowed at any stage and is not stopped
// by an open query: flagging is how a desk says "look at this", and it must
// stay possible exactly when something is wrong enough to need a query.
export async function raiseManualFlag(actorId: string, requestId: string, params: { reason: string }, meta: Meta): Promise<FlagResult> {
  const reason = params.reason.trim();
  if (!reason) return { ok: false, error: "A reason is required." };

  const resolved = await resolveViewerRole(actorId, requestId);
  if (!resolved) return { ok: false, error: "Request not found." };
  const { role } = resolved;
  if (!FLAG_ROLES.includes(role)) return { ok: false, error: "This role can't flag a request." };

  return withGrantScope(actorId, role, async (tx) => {
    await lockRequestMutex(tx, requestId);
    const [inserted] = await tx.insert(requestFlag).values({ requestId, raisedBy: actorId, raisedAsRole: role, reason }).returning({ id: requestFlag.id });
    await appendEvent(
      tx,
      { requestId, actor: actorId, roleAtTime: role, type: "request.flagged", objectType: "request_flag", objectId: inserted.id, before: {}, after: { reason }, reason },
      meta,
    );
    return { ok: true };
  });
}

export async function clearManualFlag(actorId: string, flagId: string, meta: Meta): Promise<FlagResult> {
  // Resolve the request from the flag through each held desk role, letting
  // RLS decide (same approach as resolveViewerRole): a flag the viewer
  // can't see doesn't exist for them.
  for (const role of FLAG_ROLES) {
    let outcome: FlagResult | null = null;
    try {
      outcome = await withGrantScope(actorId, role, async (tx) => {
        const [flag] = await tx.select().from(requestFlag).where(eq(requestFlag.id, flagId)).limit(1);
        if (!flag) return null as unknown as FlagResult;
        await lockRequestMutex(tx, flag.requestId);
        if (flag.clearedAt) return { ok: false, error: "This flag is already cleared." } as FlagResult;

        const cleared = await tx
          .update(requestFlag)
          .set({ clearedBy: actorId, clearedAt: new Date() })
          .where(and(eq(requestFlag.id, flagId), isNull(requestFlag.clearedAt)))
          .returning({ id: requestFlag.id });
        if (cleared.length === 0) return { ok: false, error: "You can't clear this flag." } as FlagResult;

        await appendEvent(
          tx,
          { requestId: flag.requestId, actor: actorId, roleAtTime: role, type: "request.flag_cleared", objectType: "request_flag", objectId: flag.id, before: { reason: flag.reason }, after: {}, reason: null },
          meta,
        );
        return { ok: true } as FlagResult;
      });
    } catch {
      continue; // no active grant for this role
    }
    if (outcome) return outcome;
  }
  return { ok: false, error: "Flag not found." };
}
