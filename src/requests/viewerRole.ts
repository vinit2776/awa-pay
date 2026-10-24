import { eq } from "drizzle-orm";
import { type Role, type ScopedTx, withViewerRole } from "@/db/runtime";
import { request } from "@/db/schema";

// A person can hold several roles (three role_grant rows). RLS visibility
// differs per role — so "which role am I viewing this request as" isn't
// something the app can just decide; it tries each held role in priority
// order and lets RLS itself be the arbiter (does this role's scoped query
// return the row at all). Whichever succeeds is the resolved role.
//
// If every held role comes back empty, the request doesn't exist for this
// viewer — that IS the department/company isolation guarantee ("cannot
// see another department's request by editing the URL"), enforced by RLS
// at read time, not by hiding a panel in React (AGENTS.md rule 8).
//
// The whole probe is one transaction (withViewerRole), not one per role.
export const ROLE_PRIORITY: Role[] = ["approver", "accountant", "payer", "requester", "super_admin", "developer"];

export type RequestRow = typeof request.$inferSelect;

export const selectRequestById = (requestId: string) => async (tx: ScopedTx) =>
  (await tx.select().from(request).where(eq(request.id, requestId)))[0];

export async function resolveViewerRole(
  userId: string,
  requestId: string,
): Promise<{ role: Role; request: RequestRow } | null> {
  return withViewerRole(userId, ROLE_PRIORITY, selectRequestById(requestId), async (_tx, { role, probed }) => ({ role, request: probed }));
}
