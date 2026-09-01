import { desc, eq } from "drizzle-orm";
import type { ScopedTx } from "@/db/runtime";
import { event } from "@/db/schema";
import { computeEventHash } from "./hash";

// Extracted from src/requests/transitions.ts's runTransition, which was
// the only writer of event rows through phase 4. Phase 5's query/nudge
// modules need the exact same race-free hash-chain append but aren't
// stage transitions — no fromStages/toStage, and they must remain postable
// regardless of the request's current stage — so they can't go through
// runTransition itself. This is the one hash-chain-append code path both
// use, rather than two independently-maintained copies of the same logic.
//
// Precondition, not enforced here: the caller has already taken
// SELECT ... FOR UPDATE on the request row earlier in this same
// transaction. Locking stays tied to why the caller is reading the row in
// the first place (stage validation in runTransition; existence +
// department-scope checks in queriesCore/nudgesCore) — this function only
// guarantees that "read latest hash, compute, insert" is race-free given
// that lock is already held, not that it's held at all.
export type AppendEventFields = {
  requestId: string;
  actor: string;
  roleAtTime: string;
  type: string;
  objectType: string;
  objectId: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
};

export type Meta = { ip: string; userAgent: string | undefined };

export async function appendEvent(tx: ScopedTx, fields: AppendEventFields, meta: Meta): Promise<{ id: string; hash: string }> {
  const [latest] = await tx.select({ hash: event.hash }).from(event).where(eq(event.requestId, fields.requestId)).orderBy(desc(event.at)).limit(1);
  const prevHash = latest?.hash ?? null;

  const hash = computeEventHash(fields, prevHash);

  const [inserted] = await tx
    .insert(event)
    .values({ ...fields, ip: meta.ip, userAgent: meta.userAgent, prevHash, hash })
    .returning({ id: event.id, hash: event.hash });

  return inserted;
}
