import { and, eq, isNull, sql } from "drizzle-orm";
import { type Role, type ScopedTx, withActorScope, withGrantScope } from "@/db/runtime";
import { duplicateCheck, roleGrant, user } from "@/db/schema";

// Authorizes a duplicate override: never trust a client-supplied flag,
// always re-check the actor's own active role_grant row directly. Shared
// by captureCore.ts (capture-time override) and transitions.ts
// (accountRequest's own override) — both gate the identical action
// (lifting the application's blocked_paid warning), so this is the one
// place that check lives rather than two copies drifting apart.
export async function actorHoldsRole(userId: string, role: Role): Promise<boolean> {
  const [grant] = await withActorScope(userId, (tx) =>
    tx.select({ id: roleGrant.id }).from(roleGrant).where(and(eq(roleGrant.userId, userId), eq(roleGrant.role, role), isNull(roleGrant.revokedAt))).limit(1),
  );
  return Boolean(grant);
}

// Pure orchestration, no next/headers — mirrors vendorsCore.ts's shape.
// The real matching work happens inside app_duplicate_check_candidates
// (drizzle/migrations/0018_duplicate_control_rls_and_grants.sql), a
// SECURITY DEFINER function that searches every department regardless of
// the caller's own RLS scope and computes viewable_by_actor itself, from
// the calling session's own GUCs — this module never widens visibility on
// its own, it only shapes and redacts what that function already decided.

export type DuplicateVerdict = "blocked_paid" | "warned_open" | "escalated_rejected" | "linked_held" | "matched_advance" | "none";

// How the vendor of a new bill was recognised as the vendor of an open
// advance. vendor_key is exact (the accounts desk has matched a vendor);
// gstin and vendor_name are what a bill itself says, at capture, and are
// weaker — see drizzle/migrations/0027_open_advance_candidates.sql.
export type AdvanceRecognisedBy = "vendor_key" | "gstin" | "vendor_name";

// The part of a match that only exists for matched_advance: what money is
// already out against the advance the new bill probably belongs to. Null
// unless the actor can see the advance's department (same redaction as the
// rest of DuplicateMatch), and absent for every other verdict.
export type OpenAdvance = {
  ref: string;
  currency: string;
  quotedMinor: number;
  paidMinor: number;
  recognisedBy: AdvanceRecognisedBy;
  // True when the actor is the requester who raised the advance — the only
  // requester attachInvoice will let attach its invoice.
  raisedByActor: boolean;
};

export type DuplicateMatch = {
  requestId: string;
  // null when the match is in a department this actor can't see —
  // redacted down to just enough to say "something matched, ask around."
  reference: string | null;
  invoiceDate: string | null;
  stage: string;
  matchKind: "vendor_invoice_fy" | "file_checksum" | "open_advance";
  viewableByActor: boolean;
  advance?: OpenAdvance | null;
  // Only populated when !viewableByActor — resolved via
  // app_users_with_scope (0008), same reverse-lookup function phase 5's
  // @mention resolution and phase 8's email recipients already share.
  viewerHint: string | null;
};

export type DuplicateCheckResult = { verdict: DuplicateVerdict; match: DuplicateMatch | null };

const STAGE_VERDICT: Record<string, DuplicateVerdict> = {
  paid: "blocked_paid",
  rejected: "escalated_rejected",
  on_hold: "linked_held",
};

// Highest-priority match wins when several candidates come back — a paid
// match always outranks an open one, matching §08's own verdict priority
// (a hard block matters more than a soft warning even if the open match
// happens to sort first).
// matched_advance ranks below every match on the bill itself: it says "this
// vendor has an advance open", not "this bill was seen before", so a specific
// identity match on the same request is the more useful thing to report.
const VERDICT_PRIORITY: DuplicateVerdict[] = ["blocked_paid", "escalated_rejected", "linked_held", "warned_open", "matched_advance", "none"];

type CandidateRow = {
  requestId: string;
  departmentId: string;
  stage: string;
  invoiceDate: string | null;
  reference: string | null;
  matchKind: "vendor_invoice_fy" | "file_checksum";
  viewableByActor: boolean;
};

export async function checkDuplicates(
  actorId: string,
  role: Role,
  params: { excludeRequestId?: string; vendorKey?: string | null; invoiceKey?: string | null; fy?: string | null; checksum?: string | null },
): Promise<DuplicateCheckResult> {
  if (!params.checksum && !(params.vendorKey && params.invoiceKey && params.fy)) {
    return { verdict: "none", match: null };
  }

  return withGrantScope(actorId, role, async (tx) => {
    const rows = await tx.execute<{
      request_id: string;
      department_id: string;
      stage: string;
      invoice_date: string | null;
      reference: string | null;
      match_kind: "vendor_invoice_fy" | "file_checksum";
      viewable_by_actor: boolean;
    }>(sql`
      select * from app_duplicate_check_candidates(
        ${params.excludeRequestId ?? null},
        ${params.vendorKey ?? null},
        ${params.invoiceKey ?? null},
        ${params.fy ?? null},
        ${params.checksum ?? null}
      )
    `);

    const candidates: CandidateRow[] = rows.map((r) => ({
      requestId: r.request_id,
      departmentId: r.department_id,
      stage: r.stage,
      invoiceDate: r.invoice_date,
      reference: r.reference,
      matchKind: r.match_kind,
      viewableByActor: r.viewable_by_actor,
    }));

    if (candidates.length === 0) {
      return { verdict: "none", match: null };
    }

    // Rank each candidate by its own stage's verdict priority, take the
    // worst (highest-priority) one.
    const best = candidates
      .map((c) => ({ c, verdict: STAGE_VERDICT[c.stage] ?? "warned_open" }))
      .sort((a, b) => VERDICT_PRIORITY.indexOf(a.verdict) - VERDICT_PRIORITY.indexOf(b.verdict))[0];

    const viewerHint = best.c.viewableByActor ? null : await viewerHintFor(tx, best.c.departmentId);

    return {
      verdict: best.verdict,
      match: {
        requestId: best.c.requestId,
        reference: best.c.viewableByActor ? best.c.reference : null,
        invoiceDate: best.c.viewableByActor ? best.c.invoiceDate : null,
        stage: best.c.viewableByActor ? best.c.stage : "unknown",
        matchKind: best.c.matchKind,
        viewableByActor: best.c.viewableByActor,
        viewerHint,
      },
    };
  });
}

// Only populated when the actor can't see the match — resolved via
// app_users_with_scope (0008), same reverse-lookup function phase 5's
// @mention resolution and phase 8's email recipients already share.
async function viewerHintFor(tx: ScopedTx, departmentId: string): Promise<string | null> {
  const [candidate] = await tx.execute<{ user_id: string }>(
    sql`select user_id from app_users_with_scope(ARRAY['approver']::text[], ${departmentId}::uuid) limit 1`,
  );
  if (!candidate) return null;
  const [named] = await tx.select({ name: user.name }).from(user).where(sql`${user.id} = ${candidate.user_id}`).limit(1);
  return named ? `ask ${named.name}, an approver in that department` : null;
}

// The sixth verdict (concept-v2.html section 09): does this vendor already
// have an advance paid and a tax invoice still awaited? Advisory by
// construction — it cannot tell a genuine second bill from the invoice the
// advance is waiting for, so the answer is an offer to attach and a
// recorded decline, never a block. Every open advance is returned (viewable
// ones first, oldest first): a vendor can hold two, and attaching to the
// wrong one is its own mistake, so the desk chooses rather than being handed
// the first. The database's one_payment_per_invoice index is what stops the
// double payment if everyone clicks through.
export async function checkOpenAdvances(
  actorId: string,
  role: Role,
  params: { excludeRequestId?: string; vendorKey?: string | null; gstin?: string | null; vendorName?: string | null },
): Promise<DuplicateMatch[]> {
  if (!params.vendorKey && !params.gstin && !params.vendorName) return [];

  return withGrantScope(actorId, role, async (tx) => {
    const rows = await tx.execute<{
      request_id: string;
      department_id: string;
      ref: string;
      stage: string;
      currency: string;
      quoted_minor: string;
      paid_minor: string;
      match_kind: AdvanceRecognisedBy;
      viewable_by_actor: boolean;
      raised_by_actor: boolean;
    }>(sql`
      select * from app_open_advance_candidates(
        ${params.excludeRequestId ?? null},
        ${params.vendorKey ?? null},
        ${params.gstin ?? null},
        ${params.vendorName ?? null}
      )
    `);

    const matches: DuplicateMatch[] = [];
    for (const r of rows) {
      const viewerHint = r.viewable_by_actor ? null : await viewerHintFor(tx, r.department_id);
      matches.push({
        requestId: r.request_id,
        reference: null,
        invoiceDate: null,
        stage: r.viewable_by_actor ? r.stage : "unknown",
        matchKind: "open_advance",
        viewableByActor: r.viewable_by_actor,
        viewerHint,
        advance: r.viewable_by_actor
          ? {
              ref: r.ref,
              currency: r.currency,
              quotedMinor: Number(r.quoted_minor),
              paidMinor: Number(r.paid_minor),
              recognisedBy: r.match_kind,
              raisedByActor: r.raised_by_actor,
            }
          : null,
      });
    }
    return matches;
  });
}

// One row per open advance the bill was offered against. `decline` set means
// the person offered the attach said no, and why (overridden_by/reason, the
// same pair a blocked_paid override uses). Unset means the offer was
// surfaced and not answered (a bill raised offline).
export async function recordAdvanceMatches(
  tx: ScopedTx,
  requestId: string,
  matches: DuplicateMatch[],
  decline: { by: string; reason: string } | null,
): Promise<void> {
  for (const match of matches) {
    await tx.insert(duplicateCheck).values({
      requestId,
      matchedRequestId: match.requestId,
      signals: ["open_advance", ...(match.advance ? [`via_${match.advance.recognisedBy}`] : [])],
      score: 1,
      verdict: "matched_advance",
      overriddenBy: decline?.by ?? null,
      reason: decline?.reason ?? null,
    });
  }
}

export async function recordDuplicateCheck(
  tx: ScopedTx,
  requestId: string,
  match: DuplicateMatch,
  verdict: DuplicateVerdict,
  override: { by: string; reason: string } | null,
): Promise<void> {
  await tx.insert(duplicateCheck).values({
    requestId,
    matchedRequestId: match.requestId,
    signals: [match.matchKind],
    score: 1,
    verdict,
    overriddenBy: override?.by ?? null,
    reason: override?.reason ?? null,
  });
}
