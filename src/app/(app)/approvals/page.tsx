import { eq, inArray } from "drizzle-orm";
import { verifySession } from "@/auth/dal";
import { withGrantScope } from "@/db/runtime";
import { department, request, user } from "@/db/schema";
import { computeFlags, loadFlagContext } from "@/flags/computeFlags";
import { formatMinorUnits } from "@/lib/money";
import { loadStageEntered } from "@/requests/queueData";
import { HOLD_ESCALATION_DAYS, HOLD_SUB_REASON_LABEL, daysSince, groupRows, shortDate, todayInIndia } from "@/requests/queueRows";
import { Pill } from "@/ui/Pill";
import { QueueHeader } from "@/ui/QueueHeader";
import { QueueList, type QueueGroup, type QueueRow } from "@/ui/QueueList";

export default async function ApprovalsPage() {
  const session = await verifySession();
  const now = new Date();
  const today = todayInIndia(now);

  const [rows, flagContext, stageEntered] = await withGrantScope(session.userId, "approver", async (tx) => {
    const result = await tx
      .select({ request, departmentName: department.name, raisedByName: user.name })
      .from(request)
      .innerJoin(department, eq(department.id, request.departmentId))
      .leftJoin(user, eq(user.id, request.raisedBy))
      .where(inArray(request.stage, ["awaiting_approval", "on_hold"]));
    const requests = result.map((r) => r.request);
    return [result, await loadFlagContext(tx, requests), await loadStageEntered(tx, requests)] as const;
  });

  const withDays = rows.map((row) => ({ ...row, days: daysSince(stageEntered.get(row.request.id) ?? row.request.createdAt, now) }));
  const waiting = withDays.filter((r) => r.request.stage === "awaiting_approval").sort((a, b) => b.days - a.days);
  const held = withDays
    .filter((r) => r.request.stage === "on_hold")
    .sort((a, b) => (a.request.holdReviewOn ?? "").localeCompare(b.request.holdReviewOn ?? ""));

  const toRow = ({ request: r, departmentName, raisedByName, days }: (typeof withDays)[number]): QueueRow => {
    const flags = computeFlags(r, flagContext);
    const onHold = r.stage === "on_hold";
    const reviewDue = onHold && r.holdReviewOn !== null && r.holdReviewOn <= today;
    return {
      id: r.id,
      href: `/requests/${r.id}`,
      ref: r.revision > 1 ? `${r.ref} · rev ${r.revision}` : r.ref,
      title: r.vendor ?? "Unknown vendor",
      meta: onHold ? `${departmentName} · raised by ${raisedByName ?? "former user"}` : `raised by ${raisedByName ?? "former user"}`,
      badges: (
        <>
          {r.linkedRequest && <Pill tone="info">Reconsidered</Pill>}
          {onHold && r.holdSubReason && <Pill tone="warn">{HOLD_SUB_REASON_LABEL[r.holdSubReason] ?? r.holdSubReason}</Pill>}
          {onHold && days > HOLD_ESCALATION_DAYS && <Pill tone="danger">Held {days}d</Pill>}
        </>
      ),
      flags,
      amountMinor: r.amountMinor,
      currency: r.currency,
      aside: onHold ? (r.holdReviewOn ? `review ${shortDate(r.holdReviewOn)}` : undefined) : `${days}d waiting`,
      asideTone: onHold ? (reviewDue ? "late" : "muted") : flags.some((f) => f.key === "ageing") ? "late" : "muted",
    };
  };

  // Each department the approver covers gets its own group, oldest bill
  // first; held bills sit apart because they're deliberately parked and
  // don't count towards ageing.
  const groups: QueueGroup[] = [
    ...groupRows(waiting, (r) => r.departmentName)
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((g) => ({ key: `dept-${g.key}`, label: g.key, rows: g.rows.map(toRow) })),
    { key: "held", label: "On hold · left out of ageing", rows: held.map(toRow) },
  ];

  const total = waiting.filter((r) => r.request.currency === "INR").reduce((sum, r) => sum + r.request.amountMinor, 0);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-4 py-6">
      <QueueHeader
        title="Approvals"
        summary={waiting.length === 0 && held.length === 0 ? undefined : `${waiting.length} waiting · ${formatMinorUnits(total)} · ${held.length} on hold`}
      />
      <QueueList groups={groups} empty="Nothing waiting for your approval." />
    </div>
  );
}
