import Link from "next/link";
import { notFound } from "next/navigation";
import { renderEventSummary } from "@/events/render";
import { computeFlags } from "@/flags/computeFlags";
import { FlagDots } from "@/flags/FlagDots";
import { formatMinorUnits } from "@/lib/money";
import { loadRequestView } from "@/requests/requestView";
import { presignGetUrl } from "@/storage/r2";
import { verifySession } from "@/auth/dal";
import { ApproverPanel } from "./ApproverPanel";
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
    paymentRow,
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

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8">
      <div>
        <h1 className="text-2xl font-semibold">
          {req.ref}
          <FlagDots flags={computeFlags(req, flagContext)} />
        </h1>
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
