import { and, desc, eq, ilike, or } from "drizzle-orm";
import Link from "next/link";
import { verifySession } from "@/auth/dal";
import { withGrantScope } from "@/db/runtime";
import { department, request } from "@/db/schema";
import { computeFlags, loadFlagContext } from "@/flags/computeFlags";
import { formatMinorUnits } from "@/lib/money";
import { FlagChips } from "@/ui/FlagChips";
import { StagePill } from "@/ui/StageTrack";

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
                <span className="ml-2">
                  <StagePill stage={r.stage} />
                </span>
                <FlagChips flags={computeFlags(r, flagContext)} />
              </span>
              <span className="font-medium">{formatMinorUnits(r.amountMinor, r.currency)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
