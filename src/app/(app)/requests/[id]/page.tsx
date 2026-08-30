import { and, asc, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { withGrantScope } from "@/db/runtime";
import { accounting, company, department, event, headOfAccount, payment, requestFile, user } from "@/db/schema";
import { renderEventSummary } from "@/events/render";
import { formatMinorUnits } from "@/lib/money";
import { resolveViewerRole } from "@/requests/viewerRole";
import { presignGetUrl } from "@/storage/r2";
import { verifySession } from "@/auth/dal";
import { ApproverPanel } from "./ApproverPanel";
import { AccountantPanel } from "./AccountantPanel";
import { PayerPanel } from "./PayerPanel";

export default async function RequestDetailPage({ params }: PageProps<"/requests/[id]">) {
  const { id } = await params;
  const session = await verifySession();

  const resolved = await resolveViewerRole(session.userId, id);
  if (!resolved) {
    notFound();
  }
  const { role, request: req } = resolved;

  const [department_, files, accountingRows, paymentRow, events] = await withGrantScope(session.userId, role, async (tx) => {
    const [dept] = await tx.select().from(department).where(eq(department.id, req.departmentId)).limit(1);
    const bills = await tx
      .select()
      .from(requestFile)
      .where(and(eq(requestFile.requestId, req.id), eq(requestFile.kind, "bill")))
      .orderBy(asc(requestFile.pageNo));
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
    return [dept, bills, accountingHistory, pay ?? null, eventRows];
  });

  const filesWithUrls = await Promise.all(
    files.map(async (f) => ({ ...f, downloadUrl: await presignGetUrl(f.storageKey) })),
  );

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

  const companyForPayer =
    role === "payer" && req.companyId
      ? (await withGrantScope(session.userId, "payer", (tx) => tx.select().from(company).where(eq(company.id, req.companyId!)).limit(1)))[0]
      : null;

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

      {req.note && <p className="text-sm">{req.note}</p>}

      {(latestAccounting || paymentRow) && (
        <div className="flex flex-col gap-1 text-sm text-zinc-600 dark:text-zinc-400">
          {latestAccounting && (
            <p>
              Voucher {latestAccounting.voucherNo} · booked {latestAccounting.bookedOn}
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

      {role === "requester" && req.stage === "raised" && req.revision > 1 && (
        <Link
          href={`/requests/${req.id}/resubmit`}
          className="rounded bg-black px-4 py-2 text-center text-sm font-medium text-white dark:bg-white dark:text-black"
        >
          Resubmit as revision {req.revision + 1}
        </Link>
      )}

      {role === "approver" && (req.stage === "awaiting_approval" || req.stage === "on_hold") && (
        <ApproverPanel requestId={req.id} stage={req.stage} />
      )}
      {role === "accountant" && req.stage === "with_accounts" && (
        <AccountantPanel requestId={req.id} companies={companies} heads={heads} />
      )}
      {role === "payer" && req.stage === "to_pay" && (
        <PayerPanel requestId={req.id} bankAccountsJson={companyForPayer?.bankAccounts ?? []} />
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
    </div>
  );
}
