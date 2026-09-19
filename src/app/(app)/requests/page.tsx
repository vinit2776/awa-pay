import { and, desc, eq, ilike, or } from "drizzle-orm";
import Link from "next/link";
import { verifySession } from "@/auth/dal";
import { withGrantScope } from "@/db/runtime";
import { department, request } from "@/db/schema";
import { computeFlags, loadFlagContext } from "@/flags/computeFlags";
import { FlagDots } from "@/flags/FlagDots";
import { formatMinorUnits } from "@/lib/money";

// Human labels and pill colors for every requestStageEnum value
// (src/db/schema/enums.ts) — no shared Badge component exists in this
// codebase (each queue page hand-rolls its own pill), but eight stages
// on one page is enough repetition to warrant a local lookup rather than
// eight inline ternaries.
const STAGE_LABEL: Record<string, string> = {
  raised: "raised",
  awaiting_approval: "awaiting approval",
  with_accounts: "with accounts",
  to_pay: "to pay",
  paid: "paid",
  on_hold: "on hold",
  rejected: "rejected",
  withdrawn: "withdrawn",
  awaiting_invoice: "invoice awaited",
};

const STAGE_PILL_CLASS: Record<string, string> = {
  raised: "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200",
  awaiting_approval: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  with_accounts: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200",
  to_pay: "bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-200",
  paid: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  on_hold: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  rejected: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  withdrawn: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  awaiting_invoice: "bg-violet-100 text-violet-800 dark:bg-violet-900 dark:text-violet-200",
};

function StagePill({ stage }: { stage: string }) {
  return (
    <span className={`ml-2 rounded px-2 py-0.5 text-xs ${STAGE_PILL_CLASS[stage] ?? STAGE_PILL_CLASS.raised}`}>
      {STAGE_LABEL[stage] ?? stage}
    </span>
  );
}

export default async function MyRequestsPage({ searchParams }: PageProps<"/requests">) {
  const session = await verifySession();
  const { q } = await searchParams;
  const term = typeof q === "string" ? q.trim() : "";

  const [rows, flagContext] = await withGrantScope(session.userId, "requester", async (tx) => {
    const conditions = [eq(request.raisedBy, session.userId)];
    if (term) {
      conditions.push(or(ilike(request.ref, `%${term}%`), ilike(request.vendor, `%${term}%`), ilike(request.invoiceNo, `%${term}%`))!);
    }

    const result = await tx
      .select({ request, departmentName: department.name })
      .from(request)
      .innerJoin(department, eq(department.id, request.departmentId))
      .where(and(...conditions))
      .orderBy(desc(request.createdAt));

    return [result, await loadFlagContext(tx, result.map((r) => r.request))] as const;
  });

  return (
    <div className="flex flex-1 flex-col gap-4 px-4 py-8">
      <h1 className="text-2xl font-semibold">My requests</h1>

      <form className="flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={term}
          placeholder="Search by ref, vendor, or invoice number"
          className="flex-1 rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700"
        />
        <button type="submit" className="rounded border border-zinc-300 px-4 py-2 text-sm font-medium dark:border-zinc-700">
          Search
        </button>
      </form>

      {rows.length === 0 && (
        <p className="text-zinc-600 dark:text-zinc-400">
          {term ? "No requests match that search." : "You haven't raised any requests yet."}
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {rows.map(({ request: r, departmentName }) => (
          <li key={r.id}>
            <Link
              href={`/requests/${r.id}`}
              className="flex items-center justify-between rounded border border-zinc-300 px-4 py-3 dark:border-zinc-700"
            >
              <span>
                <span className="font-medium">{r.ref}</span>
                {r.vendor && <span className="text-zinc-600 dark:text-zinc-400"> · {r.vendor}</span>}
                <span className="text-zinc-600 dark:text-zinc-400"> · {departmentName}</span>
                <StagePill stage={r.stage} />
                <FlagDots flags={computeFlags(r, flagContext)} />
              </span>
              <span className="font-medium">{formatMinorUnits(r.amountMinor, r.currency)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
