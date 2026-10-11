import Link from "next/link";
import { hasActiveFilters, type QueueParams } from "@/requests/queueFilter";

const field = "rounded border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700";

// A plain GET form: every filter lives in the URL, so a filtered queue can
// be bookmarked or shared and works without client-side JavaScript. The
// department filter only appears when the queue spans more than one: the
// requester never picks a department, so for a desk scoped to a single
// one it would be a dropdown with nothing to choose.
export function QueueFilters({
  path,
  params,
  departments,
  shown,
  total,
  showHoldFilter = false,
  showPayerStateFilter = false,
}: {
  path: string;
  params: QueueParams;
  departments: string[];
  shown: number;
  total: number;
  showHoldFilter?: boolean;
  showPayerStateFilter?: boolean;
}) {
  return (
    <form method="get" action={path} className="flex flex-col gap-2">
      <input
        type="search"
        name="q"
        defaultValue={params.q}
        placeholder="Search ref, vendor, bill no., requester, note"
        aria-label="Search requests"
        className={`${field} w-full`}
      />
      <div className="flex flex-wrap items-center gap-2">
        {departments.length > 1 && (
          <select name="dept" defaultValue={params.dept} aria-label="Department" className={field}>
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        )}
        <select name="age" defaultValue={params.minAgeDays || ""} aria-label="Age" className={field}>
          <option value="">Any age</option>
          <option value="3">3+ days</option>
          <option value="7">7+ days</option>
          <option value="30">30+ days</option>
        </select>
        {showHoldFilter && (
          <select name="hold" defaultValue={params.hold} aria-label="Stage" className={field}>
            <option value="all">Awaiting and on hold</option>
            <option value="awaiting">Awaiting only</option>
            <option value="hold">On hold only</option>
          </select>
        )}
        {showPayerStateFilter && (
          <select name="pstate" defaultValue={params.payerState} aria-label="Payer status" className={field}>
            <option value="all">Any payer status</option>
            <option value="none">Ready to pay</option>
            <option value="in_progress">Payment in progress</option>
            <option value="on_hold">On hold with payer</option>
          </select>
        )}
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" name="flagged" value="1" defaultChecked={params.flagged} />
          Flagged only
        </label>
        <button type="submit" className="rounded bg-black px-3 py-2 text-sm text-white dark:bg-white dark:text-black">
          Apply
        </button>
        {hasActiveFilters(params) && (
          <Link href={path} className="text-sm underline">
            Clear
          </Link>
        )}
      </div>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Showing {shown} of {total}
      </p>
    </form>
  );
}
