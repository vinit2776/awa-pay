import { eq } from "drizzle-orm";
import { verifySession } from "@/auth/dal";
import { withGrantScope } from "@/db/runtime";
import { department, request, user } from "@/db/schema";
import { computeFlags, loadFlagContext } from "@/flags/computeFlags";
import { formatMinorUnits } from "@/lib/money";
import { loadStageEntered } from "@/requests/queueData";
import { daysSince } from "@/requests/queueRows";
import { QueueHeader } from "@/ui/QueueHeader";
import { QueueList, type QueueRow } from "@/ui/QueueList";

export default async function AccountsQueuePage() {
  const session = await verifySession();
  const now = new Date();

  const [rows, flagContext, stageEntered] = await withGrantScope(session.userId, "accountant", async (tx) => {
    const result = await tx
      .select({ request, departmentName: department.name, raisedByName: user.name })
      .from(request)
      .innerJoin(department, eq(department.id, request.departmentId))
      .leftJoin(user, eq(user.id, request.raisedBy))
      .where(eq(request.stage, "with_accounts"));
    const requests = result.map((r) => r.request);
    return [result, await loadFlagContext(tx, requests), await loadStageEntered(tx, requests)] as const;
  });

  // Oldest in this stage first — accounts works the queue in the order
  // bills arrived at the desk, not the order they were raised.
  const queue: QueueRow[] = rows
    .map((row) => ({ ...row, days: daysSince(stageEntered.get(row.request.id) ?? row.request.createdAt, now) }))
    .sort((a, b) => b.days - a.days)
    .map(({ request: r, departmentName, raisedByName, days }) => {
      const flags = computeFlags(r, flagContext);
      return {
        id: r.id,
        href: `/requests/${r.id}`,
        ref: r.ref,
        title: r.vendor ?? "Unknown vendor",
        meta: `${departmentName} · raised by ${raisedByName ?? "former user"}`,
        flags,
        amountMinor: r.amountMinor,
        currency: r.currency,
        aside: `${days}d in stage`,
        asideTone: flags.some((f) => f.key === "ageing") ? "late" : "muted",
      };
    });

  const total = rows.filter((r) => r.request.currency === "INR").reduce((sum, r) => sum + r.request.amountMinor, 0);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-4 py-6">
      <QueueHeader title="To account" summary={queue.length === 0 ? undefined : `${queue.length} to book · ${formatMinorUnits(total)}`} />
      <QueueList groups={[{ key: "all", rows: queue }]} empty="Nothing waiting to be booked." />
    </div>
  );
}
