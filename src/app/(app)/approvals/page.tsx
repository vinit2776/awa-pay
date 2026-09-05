import { asc, inArray } from "drizzle-orm";
import Link from "next/link";
import { verifySession } from "@/auth/dal";
import { withGrantScope } from "@/db/runtime";
import { request } from "@/db/schema";
import { computeFlags, loadFlagContext } from "@/flags/computeFlags";
import { FlagDots } from "@/flags/FlagDots";
import { formatMinorUnits } from "@/lib/money";

export default async function ApprovalsPage() {
  const session = await verifySession();

  const [requests, flagContext] = await withGrantScope(session.userId, "approver", async (tx) => {
    const rows = await tx
      .select()
      .from(request)
      .where(inArray(request.stage, ["awaiting_approval", "on_hold"]))
      .orderBy(asc(request.createdAt));
    return [rows, await loadFlagContext(tx, rows)] as const;
  });

  return (
    <div className="flex flex-1 flex-col gap-4 px-4 py-8">
      <h1 className="text-2xl font-semibold">Approvals</h1>
      {requests.length === 0 && <p className="text-zinc-600 dark:text-zinc-400">Nothing waiting.</p>}
      <ul className="flex flex-col gap-2">
        {requests.map((r) => (
          <li key={r.id}>
            <Link
              href={`/requests/${r.id}`}
              className="flex items-center justify-between rounded border border-zinc-300 px-4 py-3 dark:border-zinc-700"
            >
              <span>
                <span className="font-medium">{r.ref}</span>
                {r.vendor && <span className="text-zinc-600 dark:text-zinc-400"> · {r.vendor}</span>}
                {r.stage === "on_hold" && (
                  <span className="ml-2 rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                    on hold
                  </span>
                )}
                <FlagDots flags={computeFlags(r, flagContext)} />
              </span>
              <span className="font-medium">{formatMinorUnits(r.amountMinor, r.currency)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
