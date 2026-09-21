import Link from "next/link";
import type { ReactNode } from "react";
import type { Flag } from "@/flags/computeFlags";
import { FlagChips } from "./FlagChips";
import { Money } from "./Money";

export type QueueRow = {
  id: string;
  href: string;
  ref: string;
  title: string;
  /** Short secondary facts: department, company, who raised it. */
  meta?: string;
  /** Inline pills beside the title — stage, hold reason, "reconsidered". */
  badges?: ReactNode;
  flags?: Flag[];
  /** Why this row needs the viewer, shown in amber under the title. */
  reason?: string | null;
  amountMinor: number;
  currency: string;
  /** Right-hand line under the amount, e.g. "3d in stage" or "due 18 Sep". */
  aside?: string;
  asideTone?: "late" | "muted";
  /** Draws the amber edge used for "needs you". */
  attention?: boolean;
};

export type QueueGroup = { key: string; label?: string; rows: QueueRow[] };

// One list for every queue. Each row is a single link — the whole row is
// the target — laid out as a two-column row that reads like a table on a
// desk screen and like a card on a phone, from the same markup.
export function QueueList({ groups, empty }: { groups: QueueGroup[]; empty: string }) {
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  if (total === 0) {
    return <p className="rounded-xl border border-line-soft bg-surface p-6 text-center text-sm text-ink-2">{empty}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) =>
        g.rows.length === 0 ? null : (
          <section key={g.key} className="flex flex-col gap-1.5">
            {g.label && (
              <h2 className="flex items-baseline gap-2 px-1 font-cond text-[11.5px] font-semibold tracking-[0.07em] text-ink-3 uppercase">
                {g.label}
                <span className="font-mono tracking-normal">{g.rows.length}</span>
              </h2>
            )}
            <ul className="flex flex-col gap-1.5 md:gap-0 md:overflow-hidden md:rounded-xl md:border md:border-line md:bg-surface">
              {g.rows.map((r) => (
                <li key={r.id} className="md:border-b md:border-line-soft md:last:border-b-0">
                  <Link
                    href={r.href}
                    className={`grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 rounded-xl border bg-surface px-3.5 py-3 transition-colors hover:bg-ground focus-visible:outline-2 focus-visible:outline-accent md:rounded-none md:border-0 ${
                      r.attention ? "border-warn-line shadow-[inset_3px_0_0_var(--warn)]" : "border-line-soft"
                    }`}
                  >
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="truncate text-sm font-semibold">{r.title}</span>
                        {r.badges}
                      </span>
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
                        <span className="font-mono">{r.ref}</span>
                        {r.meta && <span>{r.meta}</span>}
                        {r.flags && r.flags.length > 0 && <FlagChips flags={r.flags} />}
                      </span>
                      {r.reason && <span className="text-[12.5px] text-warn wrap-anywhere">{r.reason}</span>}
                    </span>
                    <span className="flex flex-col items-end gap-1 text-right">
                      <Money minor={r.amountMinor} currency={r.currency} className="text-[13.5px] font-medium" />
                      {r.aside && (
                        <span className={`font-mono text-[11.5px] ${r.asideTone === "late" ? "font-medium text-danger" : "text-ink-3"}`}>{r.aside}</span>
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ),
      )}
    </div>
  );
}
