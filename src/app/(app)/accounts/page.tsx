import { asc, eq } from "drizzle-orm";
import { verifySession } from "@/auth/dal";
import { withGrantScope } from "@/db/runtime";
import { request } from "@/db/schema";
import { computeFlags, loadFlagContext } from "@/flags/computeFlags";
import { FlagDots } from "@/flags/FlagDots";
import { filterQueue, parseQueueParams } from "@/requests/queueFilter";
import { loadQueueMeta } from "@/requests/queueMeta";
import { QueueFilters } from "../QueueFilters";
import { QueueRow } from "../QueueRow";

export default async function AccountsQueuePage({ searchParams }: PageProps<"/accounts">) {
  const session = await verifySession();
  const now = new Date();
  const params = parseQueueParams(await searchParams);

  const [requests, flagContext, queueMeta] = await withGrantScope(session.userId, "accountant", async (tx) => {
    const rows = await tx.select().from(request).where(eq(request.stage, "with_accounts")).orderBy(asc(request.createdAt));
    return [rows, await loadFlagContext(tx, rows), await loadQueueMeta(tx, rows)] as const;
  });

  const visible = filterQueue(requests, queueMeta, (r) => computeFlags(r, flagContext).length, params, now);

  return (
    <div className="flex flex-1 flex-col gap-4 px-4 py-8">
      <h1 className="text-2xl font-semibold">To account</h1>
      <QueueFilters
        path="/accounts"
        params={params}
        departments={[...new Set([...queueMeta.values()].map((m) => m.departmentName).filter((d): d is string => d !== null))].sort()}
        shown={visible.length}
        total={requests.length}
      />
      {visible.length === 0 && <p className="text-zinc-600 dark:text-zinc-400">{requests.length === 0 ? "Nothing waiting." : "No requests match these filters."}</p>}
      <ul className="flex flex-col gap-2">
        {visible.map((r) => (
          <li key={r.id}>
            <QueueRow request={r} meta={queueMeta.get(r.id)} now={now} badges={<FlagDots flags={computeFlags(r, flagContext)} />} />
          </li>
        ))}
      </ul>
    </div>
  );
}
