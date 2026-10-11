import Link from "next/link";
import type { ReactNode } from "react";
import { formatMinorUnits } from "@/lib/money";
import type { QueueMeta } from "@/requests/queueMeta";

type QueueRequest = {
  id: string;
  ref: string;
  vendor: string | null;
  amountMinor: number;
  currency: string;
  invoiceNo: string | null;
  note: string | null;
  createdAt: Date;
};

function ageLabel(raisedAt: Date, now: Date): string {
  const days = Math.floor((now.getTime() - raisedAt.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

// One row in a desk queue: the line that was always there (ref, vendor,
// amount) plus who raised it, when, from which department, the bill
// number and the requester's note, so a desk can triage from the list
// without opening every request. `badges` carries the per-desk extras
// (on hold, immediate, flag dots) next to the ref. `actions` sits below the
// link, not inside it, so a row can hold buttons and forms.
export function QueueRow({ request: r, meta, now, badges, actions }: { request: QueueRequest; meta?: QueueMeta; now: Date; badges?: ReactNode; actions?: ReactNode }) {
  const details = [
    meta?.raisedByName ? `by ${meta.raisedByName}` : null,
    `${r.createdAt.toLocaleDateString()} (${ageLabel(r.createdAt, now)})`,
    meta?.departmentName,
    r.invoiceNo ? `bill ${r.invoiceNo}` : null,
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-2 rounded border border-zinc-300 px-4 py-3 dark:border-zinc-700">
      <Link href={`/requests/${r.id}`} className="flex flex-col gap-1">
        <span className="flex items-center justify-between gap-3">
          <span>
            <span className="font-medium">{r.ref}</span>
            {r.vendor && <span className="text-zinc-600 dark:text-zinc-400"> · {r.vendor}</span>}
            {badges}
          </span>
          <span className="font-medium">{formatMinorUnits(r.amountMinor, r.currency)}</span>
        </span>
        <span className="text-sm text-zinc-600 dark:text-zinc-400">{details.join(" · ")}</span>
        {r.note && <span className="line-clamp-2 text-sm text-zinc-700 dark:text-zinc-300">&ldquo;{r.note}&rdquo;</span>}
      </Link>
      {actions}
    </div>
  );
}
