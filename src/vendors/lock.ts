import { sql } from "drizzle-orm";
import type { ScopedTx } from "@/db/runtime";

// Mirrors src/requests/lock.ts's lockRequestMutex exactly, for the same
// reason: RLS-independent, transaction-scoped serialization of a
// supersede-then-insert sequence (a new vendor_bank row superseding the
// old current one) that a plain SELECT ... FOR UPDATE can't safely provide
// here either. Salted with 1, not 0, so this lock domain can never collide
// with a request-id lock even if a request id and vendor id happened to
// hash to the same 64-bit value.
export async function lockVendorMutex(tx: ScopedTx, vendorId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${vendorId}, 1))`);
}
