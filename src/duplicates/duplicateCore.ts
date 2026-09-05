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

export type DuplicateVerdict = "blocked_paid" | "warned_open" | "escalated_rejected" | "linked_held" | "none";

export type DuplicateMatch = {
  requestId: string;
  // null when the match is in a department this actor can't see —
  // redacted down to just enough to say "something matched, ask around."
  reference: string | null;
  invoiceDate: string | null;
  stage: string;
  matchKind: "vendor_invoice_fy" | "file_checksum";
  viewableByActor: boolean;
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
const VERDICT_PRIORITY: DuplicateVerdict[] = ["blocked_paid", "escalated_rejected", "linked_held", "warned_open", "none"];

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

    let viewerHint: string | null = null;
    if (!best.c.viewableByActor) {
      const [candidate] = await tx.execute<{ user_id: string }>(
        sql`select user_id from app_users_with_scope(ARRAY['approver']::text[], ${best.c.departmentId}::uuid) limit 1`,
      );
      if (candidate) {
        const [named] = await tx.select({ name: user.name }).from(user).where(sql`${user.id} = ${candidate.user_id}`).limit(1);
        if (named) viewerHint = `ask ${named.name}, an approver in that department`;
      }
    }

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
