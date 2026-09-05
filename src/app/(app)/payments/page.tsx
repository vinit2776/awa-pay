import { and, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { verifySession } from "@/auth/dal";
import { withGrantScope } from "@/db/runtime";
import { event, request } from "@/db/schema";
import { computeFlags, loadFlagContext } from "@/flags/computeFlags";
import { FlagDots } from "@/flags/FlagDots";
import { formatMinorUnits } from "@/lib/money";

// Sort key: immediate first, then dated by due date ascending, then
// discretionary last — the brief's own payer-queue ordering. dueDate
// itself comes straight off the request row (phase 12's cached column);
// only "immediate" vs "unspecified" (both have no due date, but sort
// differently) still isn't distinguishable without the cycle text, which
// isn't cached — read from the (possibly re-approved, so "latest")
// request.approved event, same as before.
function cycleSortKey(cycle: string | undefined, dueDate: string | null): [number, string] {
  if (cycle === "immediate") return [0, ""];
  if (cycle === "dated") return [1, dueDate ?? ""];
  return [2, ""];
}

export default async function PaymentsQueuePage() {
  const session = await verifySession();

  const [requests, flagContext] = await withGrantScope(session.userId, "payer", async (tx) => {
    const rows = await tx.select().from(request).where(eq(request.stage, "to_pay"));
    return [rows, await loadFlagContext(tx, rows)] as const;
  });

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

  const latestCycleByRequest = new Map<string, string>();
  for (const e of approveEvents) {
    const after = e.after as { cycle?: string } | null;
    if (!after?.cycle) continue;
    latestCycleByRequest.set(e.requestId as string, after.cycle);
  }

  const sorted = [...requests].sort((a, b) => {
    const [orderA, dueA] = cycleSortKey(latestCycleByRequest.get(a.id), a.dueDate);
    const [orderB, dueB] = cycleSortKey(latestCycleByRequest.get(b.id), b.dueDate);
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
                  {cycle === "immediate" && (
                    <span className="ml-2 rounded bg-red-100 px-2 py-0.5 text-xs text-red-800 dark:bg-red-900 dark:text-red-200">
                      immediate
                    </span>
                  )}
                  {cycle === "dated" && r.dueDate && <span className="text-zinc-600 dark:text-zinc-400"> · due {r.dueDate}</span>}
                  <FlagDots flags={computeFlags(r, flagContext)} />
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
