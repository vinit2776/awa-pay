import { and, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { verifySession } from "@/auth/dal";
import { withGrantScope } from "@/db/runtime";
import { event, request } from "@/db/schema";
import { formatMinorUnits } from "@/lib/money";

type Cycle = { cycle: string; dueDate: string | null };

// Sort key: immediate first, then dated by due date ascending, then
// discretionary last — the brief's own payer-queue ordering, read from
// each request's (possibly re-approved, so "latest") request.approved
// event rather than a new column, since it's display/sort-only.
function cycleSortKey(cycle: Cycle | undefined): [number, string] {
  if (!cycle) return [2, ""];
  if (cycle.cycle === "immediate") return [0, ""];
  if (cycle.cycle === "dated") return [1, cycle.dueDate ?? ""];
  return [2, ""];
}

export default async function PaymentsQueuePage() {
  const session = await verifySession();

  const requests = await withGrantScope(session.userId, "payer", (tx) =>
    tx.select().from(request).where(eq(request.stage, "to_pay")),
  );

  const requestIds = requests.map((r) => r.id);
  const approveEvents =
    requestIds.length === 0
      ? []
      : await withGrantScope(session.userId, "payer", (tx) =>
          tx
            .select()
            .from(event)
            .where(and(inArray(event.requestId, requestIds), eq(event.type, "request.approved"))),
        );

  const latestCycleByRequest = new Map<string, Cycle>();
  for (const e of approveEvents) {
    const after = e.after as { cycle?: string; dueDate?: string | null } | null;
    if (!after?.cycle) continue;
    latestCycleByRequest.set(e.requestId as string, { cycle: after.cycle, dueDate: after.dueDate ?? null });
  }

  const sorted = [...requests].sort((a, b) => {
    const [orderA, dueA] = cycleSortKey(latestCycleByRequest.get(a.id));
    const [orderB, dueB] = cycleSortKey(latestCycleByRequest.get(b.id));
    if (orderA !== orderB) return orderA - orderB;
    return dueA.localeCompare(dueB);
  });

  return (
    <div className="flex flex-1 flex-col gap-4 px-4 py-8">
      <h1 className="text-2xl font-semibold">To pay</h1>
      {sorted.length === 0 && <p className="text-zinc-600 dark:text-zinc-400">Nothing waiting.</p>}
      <ul className="flex flex-col gap-2">
        {sorted.map((r) => {
          const cycle = latestCycleByRequest.get(r.id);
          return (
            <li key={r.id}>
              <Link
                href={`/requests/${r.id}`}
                className="flex items-center justify-between rounded border border-zinc-300 px-4 py-3 dark:border-zinc-700"
              >
                <span>
                  <span className="font-medium">{r.ref}</span>
                  {r.vendor && <span className="text-zinc-600 dark:text-zinc-400"> · {r.vendor}</span>}
                  {cycle?.cycle === "immediate" && (
                    <span className="ml-2 rounded bg-red-100 px-2 py-0.5 text-xs text-red-800 dark:bg-red-900 dark:text-red-200">
                      immediate
                    </span>
                  )}
                  {cycle?.cycle === "dated" && cycle.dueDate && (
                    <span className="text-zinc-600 dark:text-zinc-400"> · due {cycle.dueDate}</span>
                  )}
                </span>
                <span className="font-medium">{formatMinorUnits(r.amountMinor, r.currency)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
