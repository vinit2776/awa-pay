// Pure rules behind the queue pages — what a row says about how long a
// bill has waited, which group it sits in, and why it's waiting on the
// requester. The pages do the scoped reads; these decide the display, so
// they're testable without a database.

// Events that move a request to a different stage. Queries, answers,
// nudges and comments deliberately don't: a query freezes the request
// where it stands (AGENTS.md), it doesn't restart the clock.
export const STAGE_MOVING_EVENTS = new Set([
  "request.raised",
  "request.approved",
  "request.returned",
  "request.held",
  "request.hold_released",
  "request.rejected",
  "request.accounted",
  "request.returned_to_approver",
  "request.paid",
  "request.returned_to_accounts",
  "request.resubmitted",
  "request.withdrawn",
]);

// There's no stage-entered column on request, but every stage move writes
// an event in the same transaction (AGENTS.md rule 3), so the latest one
// is exactly when the current stage began.
export function stageEnteredAt(events: { type: string; at: Date }[], createdAt: Date): Date {
  let latest: Date | null = null;
  for (const e of events) {
    if (!STAGE_MOVING_EVENTS.has(e.type)) continue;
    if (latest === null || e.at > latest) latest = e.at;
  }
  return latest ?? createdAt;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function daysSince(from: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / MS_PER_DAY));
}

export type CycleGroup = "immediate" | "dated" | "unspecified";

export const CYCLE_GROUP_LABEL: Record<CycleGroup, string> = {
  immediate: "Immediate",
  dated: "Due by date",
  unspecified: "Payer decides",
};

export function cycleGroup(cycle: string | undefined): CycleGroup {
  return cycle === "immediate" ? "immediate" : cycle === "dated" ? "dated" : "unspecified";
}

// The payer's order: immediate first, then dated by due date (soonest
// first), then discretionary — the brief's own payer-queue ordering.
export function comparePayments(a: { cycle?: string; dueDate: string | null }, b: { cycle?: string; dueDate: string | null }): number {
  const order: Record<CycleGroup, number> = { immediate: 0, dated: 1, unspecified: 2 };
  const byGroup = order[cycleGroup(a.cycle)] - order[cycleGroup(b.cycle)];
  if (byGroup !== 0) return byGroup;
  return (a.dueDate ?? "").localeCompare(b.dueDate ?? "");
}

// Groups in first-seen order, or in `order` when given (unknown keys last).
export function groupRows<T>(rows: T[], keyOf: (row: T) => string, order?: string[]): { key: string; rows: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  const entries = [...groups.entries()].map(([key, list]) => ({ key, rows: list }));
  if (!order) return entries;
  const rank = (key: string) => {
    const i = order.indexOf(key);
    return i === -1 ? order.length : i;
  };
  return entries.sort((a, b) => rank(a.key) - rank(b.key));
}

export const HOLD_SUB_REASON_LABEL: Record<string, string> = {
  short_supply: "Short supply",
  damaged: "Damaged",
  quality_rejected: "Quality rejected",
  rate_dispute: "Rate dispute",
  awaiting_credit_note: "Awaiting credit note",
  service_not_rendered: "Service not rendered",
};

// A hold is escalated past this many days (AGENTS.md's lifecycle).
export const HOLD_ESCALATION_DAYS = 60;

// Dates on the queues are calendar dates in India, whatever the server's
// clock says — a bill "due today" means today in Pune, not in UTC.
export function todayInIndia(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
}

export function shortDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "UTC" });
}

// Why a request is waiting on its requester, in their words, or null when
// it isn't. Returned bills (stage raised), advances waiting for their tax
// invoice (awaiting_invoice — STAGE_OWNER_ROLE gives both to the
// requester), and open queries directed at the requester are the things
// only they can move.
export function needsRequesterReason(input: {
  stage: string;
  returnReason: string | null;
  openQuery: { raisedByName: string; question: string } | null;
}): string | null {
  if (input.openQuery) return `Question from ${input.openQuery.raisedByName}: “${input.openQuery.question}”`;
  if (input.stage === "raised") return input.returnReason ? `Returned: “${input.returnReason}”` : "Returned for correction";
  if (input.stage === "awaiting_invoice") return "Advance paid — attach the tax invoice to release the balance";
  return null;
}
