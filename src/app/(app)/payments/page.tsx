import { and, eq, inArray } from "drizzle-orm";
import { verifySession } from "@/auth/dal";
import { withGrantScope } from "@/db/runtime";
import { event, request } from "@/db/schema";
import { computeFlags, loadFlagContext } from "@/flags/computeFlags";
import { FlagDots } from "@/flags/FlagDots";
import { filterQueue, parseQueueParams } from "@/requests/queueFilter";
import { loadQueueMeta } from "@/requests/queueMeta";
import { QueueFilters } from "../QueueFilters";
import { QueueQueryButton } from "../QueueQueryButton";
import { QueueRow } from "../QueueRow";

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

export default async function PaymentsQueuePage({ searchParams }: PageProps<"/payments">) {
  const session = await verifySession();
  const now = new Date();
  const params = parseQueueParams(await searchParams);

  const [requests, flagContext, queueMeta] = await withGrantScope(session.userId, "payer", async (tx) => {
    const rows = await tx.select().from(request).where(eq(request.stage, "to_pay"));
    return [rows, await loadFlagContext(tx, rows), await loadQueueMeta(tx, rows)] as const;
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

  const visible = filterQueue(requests, queueMeta, (r) => computeFlags(r, flagContext).length, params, now);
  const sorted = [...visible].sort((a, b) => {
    const [orderA, dueA] = cycleSortKey(latestCycleByRequest.get(a.id), a.dueDate);
    const [orderB, dueB] = cycleSortKey(latestCycleByRequest.get(b.id), b.dueDate);
    if (orderA !== orderB) return orderA - orderB;
    return dueA.localeCompare(dueB);
  });

  return (
    <div className="flex flex-1 flex-col gap-4 px-4 py-8">
      <h1 className="text-2xl font-semibold">To pay</h1>
      <QueueFilters
        path="/payments"
        params={params}
        departments={[...new Set([...queueMeta.values()].map((m) => m.departmentName).filter((d): d is string => d !== null))].sort()}
        shown={sorted.length}
        total={requests.length}
        showPayerStateFilter
      />
      {sorted.length === 0 && <p className="text-zinc-600 dark:text-zinc-400">{requests.length === 0 ? "Nothing waiting." : "No requests match these filters."}</p>}
      <ul className="flex flex-col gap-2">
        {sorted.map((r) => {
          const cycle = latestCycleByRequest.get(r.id);
          return (
            <li key={r.id}>
              <QueueRow
                request={r}
                meta={queueMeta.get(r.id)}
                now={now}
                badges={
                  <>
                    {cycle === "immediate" && (
                      <span className="ml-2 rounded bg-red-100 px-2 py-0.5 text-xs text-red-800 dark:bg-red-900 dark:text-red-200">
                        immediate
                      </span>
                    )}
                    {cycle === "dated" && r.dueDate && <span className="text-zinc-600 dark:text-zinc-400"> · due {r.dueDate}</span>}
                    {r.payerState === "in_progress" && (
                      <span className="ml-2 rounded bg-sky-100 px-2 py-0.5 text-xs text-sky-800 dark:bg-sky-900 dark:text-sky-200">in progress</span>
                    )}
                    {r.payerState === "on_hold" && (
                      <span className="ml-2 rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                        on hold · review {r.payerReviewOn}
                      </span>
                    )}
                    <FlagDots flags={computeFlags(r, flagContext)} />
                  </>
                }
                actions={<QueueQueryButton requestId={r.id} />}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
