import Link from "next/link";
import { notFound } from "next/navigation";
import { renderEventSummary } from "@/events/render";
import { computeFlags } from "@/flags/computeFlags";
import { FlagChips } from "@/ui/FlagChips";
import { formatMinorUnits } from "@/lib/money";
import { loadRequestView } from "@/requests/requestView";
import { presignGetUrl } from "@/storage/r2";
import { verifySession } from "@/auth/dal";
import { ApproverPanel } from "./ApproverPanel";
import { AttachInvoicePanel } from "./AttachInvoicePanel";
import { AccountantPanel } from "./AccountantPanel";
import { ConversationPanel, type ConversationEntry } from "./ConversationPanel";
import { PayerPanel } from "./PayerPanel";
import { QueryPanel, type OpenQuery } from "./QueryPanel";
import { WithdrawButton } from "./WithdrawButton";

export default async function RequestDetailPage({ params }: PageProps<"/requests/[id]">) {
  const { id } = await params;
  const session = await verifySession();

  // One transaction for everything this page reads (role resolution
  // included) — see src/requests/requestView.ts.
  const view = await loadRequestView(session.userId, id);
  if (!view) {
    notFound();
  }
  const {
    role,
    req,
    department: department_,
    bills: files,
    commentAttachments,
    accountingRows,
    payments,
    events,
    comments,
    openQueryRows,
    routedApproverName,
    flagContext,
    companies,
    heads,
    canOverrideDuplicate,
    companyForPayer,
    bankReadiness,
  } = view;

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

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8">
      <div>
        <h1 className="text-2xl font-semibold">
          {req.ref}
          <FlagChips flags={computeFlags(req, flagContext)} />
        </h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          {req.vendor ?? "Unknown vendor"} · {department_?.name} · {formatMinorUnits(req.amountMinor, req.currency)}
        </p>
        <p className="text-sm text-zinc-500 dark:text-zinc-500">
          stage: {req.stage.replace(/_/g, " ")}
          {req.revision > 1 && ` · revision ${req.revision}`}
        </p>
        {(isAdvance || req.payNowMinor !== null) && (
          <p className="mt-2 rounded bg-violet-50 px-3 py-2 text-sm text-violet-900 dark:bg-violet-950 dark:text-violet-200">
            {isAdvance ? (
              <>
                <strong>Advance</strong> — money goes out before the tax invoice.{" "}
                {req.payNowMinor !== null && <>Asking for {formatMinorUnits(req.payNowMinor, req.currency)} now of a {formatMinorUnits(req.amountMinor, req.currency)} job.</>}
                {req.quotationNo && <> Quotation {req.quotationNo}.</>}
                {!invoiceIsIn && req.invoiceExpectedBy && <> Tax invoice expected by {req.invoiceExpectedBy}.</>}
                {invoiceIsIn && <> Tax invoice attached.</>}
              </>
            ) : (
              <>
                <strong>Part payment</strong> — asking for {formatMinorUnits(req.payNowMinor!, req.currency)} now of a {formatMinorUnits(req.amountMinor, req.currency)} bill.
              </>
            )}
            {req.payNowReason && <> Why: {req.payNowReason}.</>}
          </p>
        )}
      </div>

      {role === "approver" && routedApproverName && req.stage === "awaiting_approval" && (
        <p className="rounded border border-amber-400 bg-amber-50 px-3 py-2 text-sm dark:border-amber-700 dark:bg-amber-950">
          A reconsideration of a bill {routedApproverName} previously declined — routed here as a hint, not an assignment; anyone in the department pool can act on it.
        </p>
      )}

      {req.note && <p className="text-sm">{req.note}</p>}

      {(latestAccounting || payments.length > 0) && (
        <div className="flex flex-col gap-1 text-sm text-zinc-600 dark:text-zinc-400">
          {latestAccounting && (
            <p>
              Voucher {latestAccounting.voucherNo} · booked {latestAccounting.bookedOn} ·{" "}
              <Link href={`/vendors/${latestAccounting.vendorId}`} className="underline">
                view vendor
              </Link>
            </p>
          )}
          {payments.map((p) => (
            <p key={p.id}>
              Paid {formatMinorUnits(p.amountMinor, req.currency)} {p.mode.toUpperCase()} · {p.valueDate} · UTR {p.reference}
            </p>
          ))}
          {payments.length > 0 && (
            <p className="font-medium text-zinc-800 dark:text-zinc-200">
              Paid so far {formatMinorUnits(settledMinor, req.currency)} of {formatMinorUnits(req.amountMinor, req.currency)}
              {isAdvance && !invoiceIsIn ? " quoted" : ""} · balance {formatMinorUnits(balanceMinor, req.currency)}
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

      {role === "requester" && req.stage === "awaiting_invoice" && req.raisedBy === session.userId && (
        <AttachInvoicePanel
          requestId={req.id}
          vendor={req.vendor}
          currency={req.currency}
          quotedMinor={req.amountMinor}
          paidMinor={settledMinor}
          expectedBy={req.invoiceExpectedBy}
        />
      )}

      {role === "approver" && (req.stage === "awaiting_approval" || req.stage === "on_hold") && (
        <ApproverPanel requestId={req.id} stage={req.stage} />
      )}
      {role === "accountant" && req.stage === "with_accounts" && (
        <AccountantPanel requestId={req.id} companies={companies} heads={heads} vendorNameHint={req.vendor} canOverrideDuplicate={canOverrideDuplicate} />
      )}
      {role === "payer" && req.stage === "to_pay" && bankReadiness && (
        <PayerPanel
          requestId={req.id}
          bankAccountsJson={companyForPayer?.bankAccounts ?? []}
          readiness={bankReadiness}
          suggestedAmountMinor={suggestedPayMinor}
          balanceMinor={balanceMinor}
          currency={req.currency}
          invoiceIsIn={invoiceIsIn}
        />
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
