import { sql } from "drizzle-orm";
import type { ScopedTx } from "@/db/runtime";

// A per-request mutex for callers that need to serialize against
// src/requests/transitions.ts's runTransition (or against each other) but
// have no request-row data to read or write themselves — raising/
// answering a query, sending a nudge.
//
// This is deliberately NOT `SELECT request ... FOR UPDATE`, even though
// that's what runTransition itself uses. Traced empirically (real
// concurrent transactions against the dev DB, not a theoretical read of
// the docs): Postgres row-locking clauses (FOR UPDATE/FOR SHARE) require
// the row to satisfy an applicable UPDATE policy's USING clause, not just
// the SELECT policy — a row a role can plainly SELECT can still be
// silently excluded from a FOR UPDATE result set (zero rows, no error) if
// it fails that UPDATE policy check. request_update's requester branch
// requires stage = 'raised' (drizzle/migrations/0006_desks_rls_and_grants.sql)
// — fine for runTransition, since every requester-role transition
// (resubmit, withdraw) only ever fires when stage is already 'raised',
// so the two conditions always coincide there. It is NOT fine here: a
// requester can raise a query, answer one, or send a nudge on a request
// in any stage, so `SELECT request ... FOR UPDATE` as a requester on a
// non-'raised' request silently locks nothing — the mutex quietly stops
// mutexing, no error, no test failure unless something else happens to
// also be racing that exact window.
//
// A transaction-scoped advisory lock sidesteps RLS entirely — it's keyed
// on an arbitrary integer, not a table row, so no policy applies to it.
// hashtextextended gives a full 64-bit hash of the request id, making an
// accidental collision with an unrelated request astronomically unlikely
// at this app's scale (tens of concurrent transactions, not millions).
export async function lockRequestMutex(tx: ScopedTx, requestId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${requestId}, 0))`);
}
