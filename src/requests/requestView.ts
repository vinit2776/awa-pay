import { asc, desc, eq, isNull } from "drizzle-orm";
import { withViewerRole } from "@/db/runtime";
import { company, headOfAccount, user } from "@/db/schema";
import { loadFlagContext } from "@/flags/computeFlags";
import { readBankReadiness } from "@/vendors/verifyCore";
import { ROLE_PRIORITY, selectRequestById } from "./viewerRole";

// Everything the request detail page reads, in one transaction: resolve
// which of the viewer's roles can see the request, then load the request's
// whole neighbourhood under that role. The page used to make ~10 separate
// scoped transactions for this (a probe per role, one for the reads, one
// each for the accountant's pickers, the super-admin check, the payer's
// company and the bank-readiness gate), every one of them paying for its
// own BEGIN/scope/COMMIT — see scripts/bench-roundtrips.ts for the counts.
//
// Security is unchanged: role resolution is RLS-decided (withViewerRole),
// and every query below runs as the resolved role, so a nested table the
// role can't see comes back empty exactly as it would from a separate query
// (AGENTS.md rules 1 and 8). Nothing here is shown or hidden by the UI.
export async function loadRequestView(userId: string, requestId: string) {
  return withViewerRole(userId, ROLE_PRIORITY, selectRequestById(requestId), async (tx, { role, heldRoles, probed: req }) => {
    // One statement, not one per table: the request with its department,
    // files, accounting history, payment, trail, conversation and open
    // queries nested in. Each nested selection is RLS-filtered on its own
    // table, same as the separate queries it replaces.
    const bundle = await tx.query.request.findFirst({
      where: (r, { eq }) => eq(r.id, req.id),
      with: {
        department: true,
        files: true,
        accounting: { orderBy: (a) => [desc(a.accountedAt)] },
        payments: { limit: 1 },
        events: { orderBy: (e) => [asc(e.at)], with: { actorUser: { columns: { name: true } } } },
        comments: { orderBy: (c) => [asc(c.at)], with: { authorUser: { columns: { name: true } } } },
        queries: {
          where: (q) => isNull(q.resolvedAt),
          orderBy: (q) => [asc(q.at)],
          with: { raisedByUser: { columns: { name: true } } },
        },
      },
    });
    // The request was visible a moment ago in this same transaction; it
    // can only be missing if it was deleted in between.
    if (!bundle) return null;

    const bills = bundle.files.filter((f) => f.kind === "bill").sort((a, b) => a.pageNo - b.pageNo);
    const commentAttachments = bundle.files
      .filter((f) => f.kind === "comment_attachment")
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    // The reconsideration routing hint (phase 11) — a soft nudge, not
    // enforcement: any approver in the department pool can still act on
    // this request regardless of whether they're the one named here.
    const routedApproverName = req.routedApproverId
      ? ((await tx.select({ name: user.name }).from(user).where(eq(user.id, req.routedApproverId)).limit(1))[0]?.name ?? null)
      : null;

    // The department threshold and open queries were just read above; hand
    // them over rather than paying for the same rows again.
    const flagContext = await loadFlagContext(tx, [req], new Date(), {
      ageingThresholdByDept: new Map(bundle.department ? [[bundle.department.id, bundle.department.ageingThresholdDays]] : []),
      openQueryRequestIds: new Set(bundle.queries.length > 0 ? [req.id] : []),
    });

    // The accountant panel needs company/head pickers; the payer panel its
    // company's bank accounts and the bank-readiness gate. Only fetched for
    // the role that uses them — company_select is company-scoped and would
    // just return nothing to a role without company scope anyway.
    const [companies, heads] =
      role === "accountant"
        ? [
            await tx.select().from(company).where(eq(company.active, true)),
            await tx.select().from(headOfAccount).where(eq(headOfAccount.active, true)),
          ]
        : [[], []];

    const companyForPayer =
      role === "payer" && req.companyId ? ((await tx.select().from(company).where(eq(company.id, req.companyId)).limit(1))[0] ?? null) : null;

    const bankReadiness = role === "payer" && req.stage === "to_pay" ? await readBankReadiness(tx, req.id) : null;

    return {
      role,
      req,
      department: bundle.department,
      bills,
      commentAttachments,
      accountingRows: bundle.accounting,
      paymentRow: bundle.payments[0] ?? null,
      events: bundle.events.map(({ actorUser, ...e }) => ({ event: e, actorName: actorUser?.name ?? null })),
      comments: bundle.comments.map(({ authorUser, ...c }) => ({ comment: c, authorName: authorUser?.name ?? null })),
      openQueryRows: bundle.queries.map(({ raisedByUser, ...q }) => ({ query: q, raisedByName: raisedByUser?.name ?? null })),
      routedApproverName,
      flagContext,
      companies,
      heads,
      // Read from the same transaction's own role_grant read — no extra
      // query for "does this accountant also hold super_admin".
      canOverrideDuplicate: role === "accountant" && heldRoles.has("super_admin"),
      companyForPayer,
      bankReadiness,
    };
  });
}

export type RequestView = NonNullable<Awaited<ReturnType<typeof loadRequestView>>>;
