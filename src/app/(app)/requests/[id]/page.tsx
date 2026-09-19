import { and, asc, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { withGrantScope } from "@/db/runtime";
import { accounting, comment, company, department, event, headOfAccount, payment, query, requestFile, user } from "@/db/schema";
import { renderEventSummary } from "@/events/render";
import { computeFlags, loadFlagContext } from "@/flags/computeFlags";
import { FlagChips } from "@/ui/FlagChips";
import { formatMinorUnits } from "@/lib/money";
import { resolveViewerRole } from "@/requests/viewerRole";
import { STAGE_OWNER_ROLE } from "@/requests/stageOwner";
import { freezeReason, openQueries, type TimelineEntry } from "@/requests/timeline";
import { presignGetUrl } from "@/storage/r2";
import { verifySession } from "@/auth/dal";
import { checkPaymentBankReadiness } from "@/vendors/verifyCore";
import { actorHoldsRole } from "@/duplicates/duplicateCore";
import { BillViewer } from "@/ui/BillViewer";
import { DeskPanel } from "@/ui/DeskPanel";
import { Notice } from "@/ui/Notice";
import { StageTrack } from "@/ui/StageTrack";
import { buttonClass, eyebrowClass } from "@/ui/styles";
import { ApproverPanel } from "./ApproverPanel";
import { AttachInvoicePanel } from "./AttachInvoicePanel";
import { AccountantPanel } from "./AccountantPanel";
import { PayerPanel } from "./PayerPanel";
import { Timeline } from "./Timeline";
import { WithdrawButton } from "./WithdrawButton";

const DESK_TITLE: Record<string, string> = {
  requester: "Your move",
  approver: "Your decision",
  accountant: "Book this bill",
  payer: "Pay this bill",
};

export default async function RequestDetailPage({ params }: PageProps<"/requests/[id]">) {
  const { id } = await params;
  const session = await verifySession();

  const resolved = await resolveViewerRole(session.userId, id);
  if (!resolved) {
    notFound();
  }
  const { role, request: req } = resolved;
  const answerer = alias(user, "answerer");

  const [department_, files, commentAttachments, accountingRows, payments, events, comments, queryRows, routedApproverName, flagContext] = await withGrantScope(
    session.userId,
    role,
    async (tx) => {
      const [dept] = await tx.select().from(department).where(eq(department.id, req.departmentId)).limit(1);
      const bills = await tx
        .select()
        .from(requestFile)
        .where(and(eq(requestFile.requestId, req.id), eq(requestFile.kind, "bill")))
        .orderBy(asc(requestFile.pageNo));
      const attachments = await tx
        .select()
        .from(requestFile)
        .where(and(eq(requestFile.requestId, req.id), eq(requestFile.kind, "comment_attachment")))
        .orderBy(asc(requestFile.createdAt));
      const accountingHistory = await tx
        .select()
        .from(accounting)
        .where(eq(accounting.requestId, req.id))
        .orderBy(desc(accounting.accountedAt));
      // A request can take several payments until its balance is zero —
      // an advance, then the rest; or a part-payment, then the rest.
      const paymentRows = await tx.select().from(payment).where(eq(payment.requestId, req.id)).orderBy(asc(payment.paidAt));
      const eventRows = await tx
        .select({ event, actorName: user.name })
        .from(event)
        .leftJoin(user, eq(user.id, event.actor))
        .where(eq(event.requestId, req.id))
        .orderBy(asc(event.at));
      const commentRows = await tx
        .select({ comment, authorName: user.name })
        .from(comment)
        .leftJoin(user, eq(user.id, comment.author))
        .where(eq(comment.requestId, req.id))
        .orderBy(asc(comment.at));
      // Every query, not only the open ones: an answered query and the
      // answer that unfroze the request both belong in the history. The
      // freeze itself keys off resolvedAt being null, below.
      const queries = await tx
        .select({ query, raisedByName: user.name, answeredByName: answerer.name })
        .from(query)
        .leftJoin(user, eq(user.id, query.raisedBy))
        .leftJoin(answerer, eq(answerer.id, query.answeredBy))
        .where(eq(query.requestId, req.id))
        .orderBy(asc(query.at));
      // The reconsideration routing hint (phase 11) — a soft nudge, not
      // enforcement: any approver in the department pool can still act on
      // this request regardless of whether they're the one named here.
      const routedName = req.routedApproverId
        ? (await tx.select({ name: user.name }).from(user).where(eq(user.id, req.routedApproverId)).limit(1))[0]?.name ?? null
        : null;
      const flagCtx = await loadFlagContext(tx, [req]);
      return [dept, bills, attachments, accountingHistory, paymentRows, eventRows, commentRows, queries, routedName, flagCtx];
    },
  );

  const billPages = await Promise.all(
    files.map(async (f) => ({ id: f.id, pageNo: f.pageNo ?? 1, mime: f.mime, downloadUrl: await presignGetUrl(f.storageKey) })),
  );

  const timelineEntries: TimelineEntry[] = [
    ...events.map(({ event: e, actorName }) => {
      const summary = renderEventSummary(e);
      return {
        kind: "event" as const,
        id: e.id,
        at: e.at.toISOString(),
        actorName: actorName ?? "system",
        icon: summary.icon,
        label: summary.label,
        detail: summary.detail,
      };
    }),
    ...(await Promise.all(
      comments.map(async ({ comment: c, authorName }) => ({
        kind: "comment" as const,
        id: c.id,
        at: c.at.toISOString(),
        authorName: authorName ?? "Former user",
        roleAtTime: c.roleAtTime,
        body: c.body,
        attachments: await Promise.all(
          commentAttachments
            .filter((a) => a.commentId === c.id)
            .map(async (a) => ({ id: a.id, mime: a.mime, downloadUrl: await presignGetUrl(a.storageKey) })),
        ),
      })),
    )),
    ...queryRows.map(({ query: q, raisedByName, answeredByName }) => ({
      kind: "query" as const,
      id: q.id,
      at: q.at.toISOString(),
      raisedByName: raisedByName ?? "Former user",
      question: q.question,
      directedAt: q.directedAt as string[],
      answer: q.answer,
      answeredByName: answeredByName ?? null,
      resolvedAt: q.resolvedAt ? q.resolvedAt.toISOString() : null,
    })),
  ];

  const open = openQueries(timelineEntries);
  const frozen = freezeReason(open);
  const latestAccounting = accountingRows[0] ?? null;

  // The settlement ledger in miniature (concept-v2.html section 09): what
  // is owed, what has moved, what is still due. Balance is derived, never
  // typed — payRequest enforces the same ceiling under the row lock.
  const settledMinor = payments.reduce((sum, p) => sum + p.amountMinor, 0);
  const balanceMinor = req.amountMinor - settledMinor;
  const isAdvance = req.kind === "advance";
  const invoiceIsIn = !isAdvance || req.invoiceAttachedAt !== null;
  // What the payer should be prompted to pay next: an advance is capped at
  // what was asked for until its invoice is in; a part-payment request's
  // first payment is the part that was asked for; otherwise the balance.
  const suggestedPayMinor = !invoiceIsIn
    ? Math.max((req.payNowMinor ?? 0) - settledMinor, 0)
    : req.payNowMinor !== null && settledMinor < req.payNowMinor
      ? req.payNowMinor - settledMinor
      : balanceMinor;

  // The accountant panel needs company/head pickers — only fetched when
  // this viewer could actually need them, since company_select is
  // company-scoped and would otherwise just return an empty list to roles
  // that don't hold company scope at all.
  const [companies, heads] =
    role === "accountant"
      ? await withGrantScope(session.userId, "accountant", async (tx) => [
          await tx.select().from(company).where(eq(company.active, true)),
          await tx.select().from(headOfAccount).where(eq(headOfAccount.active, true)),
        ])
      : [[], []];

  const canOverrideDuplicate = role === "accountant" ? await actorHoldsRole(session.userId, "super_admin") : false;

  const companyForPayer =
    role === "payer" && req.companyId
      ? (await withGrantScope(session.userId, "payer", (tx) => tx.select().from(company).where(eq(company.id, req.companyId!)).limit(1)))[0]
      : null;

  // The payer-verification gate (phase 10) — computed here, server-side,
  // same as companies/heads above, rather than fetched client-side: it's
  // a live read (see checkPaymentBankReadiness's own comment on why),
  // fetched once per page load alongside everything else this role needs.
  const bankReadiness = role === "payer" && req.stage === "to_pay" ? await checkPaymentBankReadiness(session.userId, req.id) : null;

  const ownsThisStage = STAGE_OWNER_ROLE[req.stage] === role;
  const desk =
    role === "approver" && (req.stage === "awaiting_approval" || req.stage === "on_hold") ? (
      <ApproverPanel requestId={req.id} stage={req.stage} />
    ) : role === "accountant" && req.stage === "with_accounts" ? (
      <AccountantPanel requestId={req.id} companies={companies} heads={heads} vendorNameHint={req.vendor} canOverrideDuplicate={canOverrideDuplicate} />
    ) : role === "payer" && req.stage === "to_pay" && bankReadiness ? (
      <PayerPanel
        requestId={req.id}
        bankAccountsJson={companyForPayer?.bankAccounts ?? []}
        readiness={bankReadiness}
        billAmountMinor={req.amountMinor}
        suggestedAmountMinor={suggestedPayMinor}
        balanceMinor={balanceMinor}
        currency={req.currency}
        invoiceIsIn={invoiceIsIn}
      />
    ) : role === "requester" && req.stage === "awaiting_invoice" && req.raisedBy === session.userId ? (
      <AttachInvoicePanel
        requestId={req.id}
        vendor={req.vendor}
        currency={req.currency}
        quotedMinor={req.amountMinor}
        paidMinor={settledMinor}
        expectedBy={req.invoiceExpectedBy}
      />
    ) : role === "requester" && req.stage === "raised" ? (
      <div className="flex flex-col gap-2">
        <p className="text-[13px] text-ink-2">This is back with you. Fix what was asked for and resend it, or close it for good.</p>
        <Link href={`/requests/${req.id}/resubmit`} className={buttonClass("primary", "md", true)}>
          Resubmit as revision {req.revision + 1}
        </Link>
        <WithdrawButton requestId={req.id} />
      </div>
    ) : role === "requester" && req.stage === "rejected" ? (
      <div className="flex flex-col gap-2">
        <p className="text-[13px] text-ink-2">Rejected bills stay closed. If circumstances changed, raise it again — it goes back to the approver who declined it, never silently.</p>
        <Link href={`/requests/new?relink=${req.id}`} className={buttonClass("primary", "md", true)}>
          Reconsider — raise as a new request
        </Link>
      </div>
    ) : null;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-5 px-4 py-6">
      <header className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="font-mono text-[12.5px] text-ink-2">
              {req.ref}
              {req.revision > 1 && ` · revision ${req.revision}`}
            </span>
            <h1 className="text-xl font-semibold tracking-tight text-balance">{req.vendor ?? "Unknown vendor"}</h1>
            <p className="flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-ink-2">
              <span>{department_?.name}</span>
              {req.invoiceNo && <span className="font-mono">{req.invoiceNo}</span>}
              {req.invoiceDate && <span className="font-mono">{req.invoiceDate}</span>}
              {req.quotationNo && <span className="font-mono">Quotation {req.quotationNo}</span>}
            </p>
            <FlagChips flags={computeFlags(req, flagContext)} />
          </div>
          <p className="text-right font-mono text-2xl font-medium tracking-tight tabular-nums">
            {formatMinorUnits(req.amountMinor, req.currency)}
            <span className="block font-sans text-[11.5px] font-normal tracking-normal text-ink-3">
              {isAdvance && !invoiceIsIn ? `${req.currency} · quoted` : req.currency}
            </span>
          </p>
        </div>
        <StageTrack stage={req.stage} frozen={open.length > 0} note={ownsThisStage ? "you" : undefined} />
      </header>

      {(isAdvance || req.payNowMinor !== null) && (
        <Notice tone="info" title={isAdvance ? "Advance — money goes out before the tax invoice" : "Part payment"}>
          {isAdvance ? (
            <>
              {req.payNowMinor !== null && (
                <>
                  Asking for <span className="font-mono">{formatMinorUnits(req.payNowMinor, req.currency)}</span> now of a{" "}
                  <span className="font-mono">{formatMinorUnits(req.amountMinor, req.currency)}</span> job.{" "}
                </>
              )}
              {!invoiceIsIn && req.invoiceExpectedBy && <>Tax invoice expected by {req.invoiceExpectedBy}. </>}
              {invoiceIsIn && <>Tax invoice attached. </>}
            </>
          ) : (
            <>
              Asking for <span className="font-mono">{formatMinorUnits(req.payNowMinor!, req.currency)}</span> now of a{" "}
              <span className="font-mono">{formatMinorUnits(req.amountMinor, req.currency)}</span> bill.{" "}
            </>
          )}
          {req.payNowReason && <>Why: {req.payNowReason}.</>}
        </Notice>
      )}

      {frozen && (
        <Notice tone="warn" title="Frozen until this question is answered">
          {frozen} Nothing moves until it&apos;s answered, and the request stays where it is.
        </Notice>
      )}

      {role === "approver" && routedApproverName && req.stage === "awaiting_approval" && (
        <Notice tone="info" title={`Previously declined by ${routedApproverName}`}>
          Routed back here as a hint, not an assignment — anyone in the department pool can act on it.
        </Notice>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <BillViewer pages={billPages} />
          {req.note && (
            <p className="rounded-lg bg-sunk px-3 py-2 text-[13px]">
              <span className="font-semibold">Requester&apos;s note: </span>
              {req.note}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-4">
          {desk && (
            <DeskPanel title={DESK_TITLE[role] ?? "Your move"} frozenReason={frozen ?? undefined}>
              {desk}
            </DeskPanel>
          )}

          {(latestAccounting || payments.length > 0) && (
            <section className="flex flex-col gap-3 rounded-xl border border-line-soft bg-surface p-4">
              <h2 className={eyebrowClass}>Booking &amp; payment</h2>
              {latestAccounting && (
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px]">
                  <dt className="text-ink-3">Voucher</dt>
                  <dd className="m-0 text-right font-mono">{latestAccounting.voucherNo}</dd>
                  <dt className="text-ink-3">Booked on</dt>
                  <dd className="m-0 text-right font-mono">{latestAccounting.bookedOn}</dd>
                  <dt className="text-ink-3">Vendor</dt>
                  <dd className="m-0 text-right">
                    <Link href={`/vendors/${latestAccounting.vendorId}`} className="text-accent hover:underline">
                      Open record ↗
                    </Link>
                  </dd>
                </dl>
              )}
              {payments.length > 0 && (
                <>
                  <ul className="flex flex-col gap-1.5 border-t border-line-soft pt-3 text-[13px]">
                    {payments.map((p) => (
                      <li key={p.id} className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <span className="text-ink-2">
                          {p.mode.toUpperCase()} · <span className="font-mono">{p.valueDate}</span> · UTR <span className="font-mono wrap-anywhere">{p.reference}</span>
                          {p.tdsMinor > 0 && <> · TDS {formatMinorUnits(p.tdsMinor, req.currency)}</>}
                        </span>
                        <span className="font-mono tabular-nums">{formatMinorUnits(p.amountMinor, req.currency)}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="flex flex-wrap justify-between gap-x-3 border-t border-line pt-2 text-[13px] font-semibold">
                    <span>
                      Paid {formatMinorUnits(settledMinor, req.currency)} of {formatMinorUnits(req.amountMinor, req.currency)}
                      {isAdvance && !invoiceIsIn ? " quoted" : ""}
                    </span>
                    <span className="font-mono tabular-nums">Balance {formatMinorUnits(balanceMinor, req.currency)}</span>
                  </p>
                </>
              )}
            </section>
          )}
        </div>
      </div>

      {role !== "developer" && (
        <Timeline
          requestId={req.id}
          viewerRole={role}
          entries={timelineEntries}
          canNudge={!["paid", "rejected", "withdrawn"].includes(req.stage)}
        />
      )}
    </div>
  );
}
