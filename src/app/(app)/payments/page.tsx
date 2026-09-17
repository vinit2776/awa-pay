import { and, asc, eq, inArray } from "drizzle-orm";
import { verifySession } from "@/auth/dal";
import { withGrantScope } from "@/db/runtime";
import { company, department, event, request } from "@/db/schema";
import { computeFlags, loadFlagContext } from "@/flags/computeFlags";
import { formatMinorUnits } from "@/lib/money";
import { loadStageEntered } from "@/requests/queueData";
import { CYCLE_GROUP_LABEL, comparePayments, cycleGroup, daysSince, groupRows, shortDate, todayInIndia, type CycleGroup } from "@/requests/queueRows";
import { QueueHeader } from "@/ui/QueueHeader";
import { QueueList, type QueueRow } from "@/ui/QueueList";

const GROUP_ORDER: CycleGroup[] = ["immediate", "dated", "unspecified"];

export default async function PaymentsQueuePage() {
  const session = await verifySession();
  const now = new Date();
  const today = todayInIndia(now);

  const [rows, flagContext, stageEntered, approveEvents] = await withGrantScope(session.userId, "payer", async (tx) => {
    const result = await tx
      .select({ request, departmentName: department.name, companyName: company.name })
      .from(request)
      .innerJoin(department, eq(department.id, request.departmentId))
      .leftJoin(company, eq(company.id, request.companyId))
      .where(eq(request.stage, "to_pay"));
    const requests = result.map((r) => r.request);
    const ids = requests.map((r) => r.id);
    // dueDate is cached on the request (phase 12), but "immediate" and
    // "payer decides" both have no due date and still sort differently, so
    // the cycle itself comes from the latest request.approved event — a
    // request can be re-approved after a return, and the latest one wins.
    const approvals =
      ids.length === 0
        ? []
        : await tx
            .select({ requestId: event.requestId, after: event.after })
            .from(event)
            .where(and(inArray(event.requestId, ids), eq(event.type, "request.approved")))
            .orderBy(asc(event.at));
    return [result, await loadFlagContext(tx, requests), await loadStageEntered(tx, requests), approvals] as const;
  });

  const latestCycle = new Map<string, string>();
  for (const e of approveEvents) {
    const cycle = (e.after as { cycle?: unknown } | null)?.cycle;
    if (e.requestId && typeof cycle === "string") latestCycle.set(e.requestId, cycle);
  }

  const sorted = rows
    .map((row) => ({ ...row, cycle: latestCycle.get(row.request.id) }))
    .sort((a, b) => comparePayments({ cycle: a.cycle, dueDate: a.request.dueDate }, { cycle: b.cycle, dueDate: b.request.dueDate }));

  const toRow = ({ request: r, departmentName, companyName, cycle }: (typeof sorted)[number]): QueueRow => {
    const days = daysSince(stageEntered.get(r.id) ?? r.createdAt, now);
    const dated = cycleGroup(cycle) === "dated" && r.dueDate;
    return {
      id: r.id,
      href: `/requests/${r.id}`,
      ref: r.ref,
      title: r.vendor ?? "Unknown vendor",
      meta: [companyName, departmentName].filter(Boolean).join(" · "),
      flags: computeFlags(r, flagContext),
      amountMinor: r.amountMinor,
      currency: r.currency,
      aside: dated ? `due ${shortDate(r.dueDate!)}` : `${days}d in stage`,
      asideTone: dated && r.dueDate! <= today ? "late" : "muted",
    };
  };

  const groups = groupRows(sorted, (r) => cycleGroup(r.cycle), GROUP_ORDER).map((g) => ({
    key: g.key,
    label: CYCLE_GROUP_LABEL[g.key as CycleGroup],
    rows: g.rows.map(toRow),
  }));

  const total = rows.filter((r) => r.request.currency === "INR").reduce((sum, r) => sum + r.request.amountMinor, 0);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-4 py-6">
      <QueueHeader title="To pay" summary={rows.length === 0 ? undefined : `${rows.length} to pay · ${formatMinorUnits(total)} before TDS`} />
      <QueueList groups={groups} empty="Nothing waiting to be paid." />
    </div>
  );
}
