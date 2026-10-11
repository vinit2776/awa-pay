import { asc, inArray } from "drizzle-orm";
import { verifySession } from "@/auth/dal";
import { withGrantScope } from "@/db/runtime";
import { request } from "@/db/schema";
import { computeFlags, loadFlagContext } from "@/flags/computeFlags";
import { FlagDots } from "@/flags/FlagDots";
import { filterQueue, parseQueueParams } from "@/requests/queueFilter";
import { loadQueueMeta } from "@/requests/queueMeta";
import { QueueFilters } from "../QueueFilters";
import { QueueRow } from "../QueueRow";

export default async function ApprovalsPage({ searchParams }: PageProps<"/approvals">) {
  const session = await verifySession();
  const now = new Date();
  const params = parseQueueParams(await searchParams);

  const [requests, flagContext, queueMeta] = await withGrantScope(session.userId, "approver", async (tx) => {
    const rows = await tx
      .select()
      .from(request)
      .where(inArray(request.stage, ["awaiting_approval", "on_hold"]))
      .orderBy(asc(request.createdAt));
    return [rows, await loadFlagContext(tx, rows), await loadQueueMeta(tx, rows)] as const;
  });

  const visible = filterQueue(requests, queueMeta, (r) => computeFlags(r, flagContext).length, params, now);

  return (
    <div className="flex flex-1 flex-col gap-4 px-4 py-8">
      <h1 className="text-2xl font-semibold">Approvals</h1>
      <QueueFilters
        path="/approvals"
        params={params}
        departments={[...new Set([...queueMeta.values()].map((m) => m.departmentName).filter((d): d is string => d !== null))].sort()}
        shown={visible.length}
        total={requests.length}
        showHoldFilter
      />
      {visible.length === 0 && <p className="text-zinc-600 dark:text-zinc-400">{requests.length === 0 ? "Nothing waiting." : "No requests match these filters."}</p>}
      <ul className="flex flex-col gap-2">
        {visible.map((r) => (
          <li key={r.id}>
            <QueueRow
              request={r}
              meta={queueMeta.get(r.id)}
              now={now}
              badges={
                <>
                  {r.stage === "on_hold" && (
                    <span className="ml-2 rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                      on hold
                    </span>
                  )}
                  <FlagDots flags={computeFlags(r, flagContext)} />
                </>
              }
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
