import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { verifySession } from "@/auth/dal";
import { withGrantScope } from "@/db/runtime";
import { request } from "@/db/schema";
import { formatMinorUnits } from "@/lib/money";

export default async function AccountsQueuePage() {
  const session = await verifySession();

  const requests = await withGrantScope(session.userId, "accountant", (tx) =>
    tx.select().from(request).where(eq(request.stage, "with_accounts")).orderBy(asc(request.createdAt)),
  );

  return (
    <div className="flex flex-1 flex-col gap-4 px-4 py-8">
      <h1 className="text-2xl font-semibold">To account</h1>
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
              </span>
              <span className="font-medium">{formatMinorUnits(r.amountMinor, r.currency)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
