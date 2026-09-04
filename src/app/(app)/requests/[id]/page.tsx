import { and, asc, desc, eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { withGrantScope } from "@/db/runtime";
import { accounting, comment, company, department, event, headOfAccount, payment, query, requestFile, user } from "@/db/schema";
import { renderEventSummary } from "@/events/render";
import { formatMinorUnits } from "@/lib/money";
import { resolveViewerRole } from "@/requests/viewerRole";
import { presignGetUrl } from "@/storage/r2";
import { verifySession } from "@/auth/dal";
import { checkPaymentBankReadiness } from "@/vendors/verifyCore";
import { actorHoldsRole } from "@/duplicates/duplicateCore";
import { ApproverPanel } from "./ApproverPanel";
import { AccountantPanel } from "./AccountantPanel";
import { ConversationPanel, type ConversationEntry } from "./ConversationPanel";
import { PayerPanel } from "./PayerPanel";
import { QueryPanel, type OpenQuery } from "./QueryPanel";
import { WithdrawButton } from "./WithdrawButton";

export default async function RequestDetailPage({ params }: PageProps<"/requests/[id]">) {
  const { id } = await params;
  const session = await verifySession();

  const resolved = await resolveViewerRole(session.userId, id);
  if (!resolved) {
    notFound();
  }
  const { role, request: req } = resolved;

  const [department_, files, commentAttachments, accountingRows, paymentRow, events, comments, openQueryRows, routedApproverName] = await withGrantScope(
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
      const [pay] = await tx.select().from(payment).where(eq(payment.requestId, req.id)).limit(1);
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
      const openQueries = await tx
        .select({ query, raisedByName: user.name })
        .from(query)
        .leftJoin(user, eq(user.id, query.raisedBy))
        .where(and(eq(query.requestId, req.id), isNull(query.resolvedAt)))
        .orderBy(asc(query.at));
      // The reconsideration routing hint (phase 11) — a soft nudge, not
      // enforcement: any approver in the department pool can still act on
      // this request regardless of whether they're the one named here.
      const routedName = req.routedApproverId
        ? (await tx.select({ name: user.name }).from(user).where(eq(user.id, req.routedApproverId)).limit(1))[0]?.name ?? null
        : null;
      return [dept, bills, attachments, accountingHistory, pay ?? null, eventRows, commentRows, openQueries, routedName];
    },
  );

  const filesWithUrls = await Promise.all(
    files.map(async (f) => ({ ...f, downloadUrl: await presignGetUrl(f.storageKey) })),
  );

  const conversationEntries: ConversationEntry[] = await Promise.all(
    comments.map(async ({ comment: c, authorName }) => ({
      id: c.id,
      authorName: authorName ?? "Former user",
      roleAtTime: c.roleAtTime,
      body: c.body,
      at: c.at.toISOString(),
      attachments: await Promise.all(
        commentAttachments
          .filter((a) => a.commentId === c.id)
          .map(async (a) => ({ id: a.id, mime: a.mime, downloadUrl: await presignGetUrl(a.storageKey) })),
      ),
    })),
  );

  const openQueries: OpenQuery[] = openQueryRows.map(({ query: q, raisedByName }) => ({
    id: q.id,
    question: q.question,
    directedAt: q.directedAt,
    raisedByName: raisedByName ?? "Former user",
    at: q.at.toISOString(),
  }));

  const latestAccounting = accountingRows[0] ?? null;

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

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8">
      <div>
        <h1 className="text-2xl font-semibold">{req.ref}</h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          {req.vendor ?? "Unknown vendor"} · {department_?.name} · {formatMinorUnits(req.amountMinor, req.currency)}
        </p>
        <p className="text-sm text-zinc-500 dark:text-zinc-500">
          stage: {req.stage}
          {req.revision > 1 && ` · revision ${req.revision}`}
        </p>
      </div>

      {role === "approver" && routedApproverName && req.stage === "awaiting_approval" && (
        <p className="rounded border border-amber-400 bg-amber-50 px-3 py-2 text-sm dark:border-amber-700 dark:bg-amber-950">
          A reconsideration of a bill {routedApproverName} previously declined — routed here as a hint, not an assignment; anyone in the department pool can act on it.
        </p>
      )}

      {req.note && <p className="text-sm">{req.note}</p>}

      {(latestAccounting || paymentRow) && (
        <div className="flex flex-col gap-1 text-sm text-zinc-600 dark:text-zinc-400">
          {latestAccounting && (
            <p>
              Voucher {latestAccounting.voucherNo} · booked {latestAccounting.bookedOn} ·{" "}
              <Link href={`/vendors/${latestAccounting.vendorId}`} className="underline">
                view vendor
              </Link>
            </p>
          )}
          {paymentRow && (
            <p>
              Paid {paymentRow.mode.toUpperCase()} · {paymentRow.valueDate} · UTR {paymentRow.reference}
            </p>
          )}
        </div>
      )}

      {filesWithUrls.length > 0 && (
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium">Bill</h2>
          <ul className="flex flex-col gap-1">
            {filesWithUrls.map((f) => (
              <li key={f.id}>
                <a href={f.downloadUrl} target="_blank" rel="noreferrer" className="text-sm underline">
                  Page {f.pageNo} — {f.mime === "application/pdf" ? "PDF" : "photo"}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {role === "requester" && req.stage === "raised" && (
        <div className="flex gap-2">
          <Link
            href={`/requests/${req.id}/resubmit`}
            className="flex-1 rounded bg-black px-4 py-2 text-center text-sm font-medium text-white dark:bg-white dark:text-black"
          >
            Resubmit as revision {req.revision + 1}
          </Link>
          <WithdrawButton requestId={req.id} />
        </div>
      )}

      {role === "requester" && req.stage === "rejected" && (
        <Link
          href={`/requests/new?relink=${req.id}`}
          className="rounded bg-black px-4 py-2 text-center text-sm font-medium text-white dark:bg-white dark:text-black"
        >
          Reconsider — raise as a new request
        </Link>
      )}

      {role === "approver" && (req.stage === "awaiting_approval" || req.stage === "on_hold") && (
        <ApproverPanel requestId={req.id} stage={req.stage} />
      )}
      {role === "accountant" && req.stage === "with_accounts" && (
        <AccountantPanel requestId={req.id} companies={companies} heads={heads} vendorNameHint={req.vendor} canOverrideDuplicate={canOverrideDuplicate} />
      )}
      {role === "payer" && req.stage === "to_pay" && bankReadiness && (
        <PayerPanel requestId={req.id} bankAccountsJson={companyForPayer?.bankAccounts ?? []} readiness={bankReadiness} />
      )}

      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">Trail</h2>
        <ul className="flex flex-col gap-2">
          {events.map(({ event: e, actorName }) => {
            const summary = renderEventSummary(e);
            return (
              <li key={e.id} className="text-sm">
                <span className="font-medium">
                  {summary.icon} {summary.label}
                </span>{" "}
                · {actorName ?? "system"} · {new Date(e.at).toLocaleString()}
                {summary.detail && <span className="text-zinc-600 dark:text-zinc-400"> · {summary.detail}</span>}
              </li>
            );
          })}
        </ul>
      </div>

      {role !== "developer" && <QueryPanel requestId={req.id} viewerRole={role} openQueries={openQueries} />}
      {role !== "developer" && <ConversationPanel requestId={req.id} entries={conversationEntries} />}
    </div>
  );
}
