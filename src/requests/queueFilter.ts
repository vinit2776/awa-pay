import type { QueueMeta } from "@/requests/queueMeta";

export type QueueParams = {
  q: string;
  dept: string;
  minAgeDays: number;
  flagged: boolean;
  hold: "all" | "awaiting" | "hold";
  // To pay only: what the payer has set on it (payerStates.ts).
  payerState: "all" | "none" | "in_progress" | "on_hold";
};

type RawParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
}

export function parseQueueParams(sp: RawParams): QueueParams {
  const age = Number(first(sp.age));
  const hold = first(sp.hold);
  const ps = first(sp.pstate);
  return {
    q: first(sp.q),
    dept: first(sp.dept),
    minAgeDays: [3, 7, 30].includes(age) ? age : 0,
    flagged: first(sp.flagged) === "1",
    hold: hold === "awaiting" || hold === "hold" ? hold : "all",
    payerState: ps === "none" || ps === "in_progress" || ps === "on_hold" ? ps : "all",
  };
}

export function hasActiveFilters(p: QueueParams): boolean {
  return p.q !== "" || p.dept !== "" || p.minAgeDays > 0 || p.flagged || p.hold !== "all" || p.payerState !== "all";
}

type FilterableRequest = {
  id: string;
  ref: string;
  vendor: string | null;
  invoiceNo: string | null;
  note: string | null;
  stage: string;
  createdAt: Date;
  payerState?: "in_progress" | "on_hold" | null;
};

// Narrows an already-scoped queue. The rows came out of a row-level-
// security query, so this only ever hides rows the viewer was allowed to
// see; it cannot reveal one they were not.
export function filterQueue<R extends FilterableRequest>(
  rows: R[],
  meta: Map<string, QueueMeta>,
  flagCount: (r: R) => number,
  p: QueueParams,
  now: Date,
): R[] {
  const needle = p.q.toLowerCase();
  return rows.filter((r) => {
    const m = meta.get(r.id);
    if (p.dept && m?.departmentName !== p.dept) return false;
    if (p.minAgeDays > 0 && (now.getTime() - r.createdAt.getTime()) / 86_400_000 < p.minAgeDays) return false;
    if (p.flagged && flagCount(r) === 0) return false;
    if (p.hold === "hold" && r.stage !== "on_hold") return false;
    if (p.hold === "awaiting" && r.stage === "on_hold") return false;
    if (p.payerState === "none" && r.payerState) return false;
    if ((p.payerState === "in_progress" || p.payerState === "on_hold") && r.payerState !== p.payerState) return false;
    if (needle) {
      const haystack = [r.ref, r.vendor, r.invoiceNo, r.note, m?.raisedByName, m?.departmentName].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}
