import { eq } from "drizzle-orm";
import { type Role, withGrantScope } from "@/db/runtime";
import { request } from "@/db/schema";

// A person can hold several roles (three role_grant rows). withGrantScope
// binds exactly one app.actor_role per transaction, and RLS visibility
// differs per role — so "which role am I viewing this request as" isn't
// something the app can just decide; it tries each held role in priority
// order and lets RLS itself be the arbiter (does this role's scoped query
// return the row at all). Whichever succeeds is the resolved role.
//
// If every held role comes back empty, the request doesn't exist for this
// viewer — that IS the department/company isolation guarantee ("cannot
// see another department's request by editing the URL"), enforced by RLS
// at read time, not by hiding a panel in React (AGENTS.md rule 8).
const ROLE_PRIORITY: Role[] = ["approver", "accountant", "payer", "requester", "super_admin", "developer"];

export type RequestRow = typeof request.$inferSelect;

export async function resolveViewerRole(
  userId: string,
  requestId: string,
): Promise<{ role: Role; request: RequestRow } | null> {
  for (const role of ROLE_PRIORITY) {
    try {
      const [row] = await withGrantScope(userId, role, (tx) => tx.select().from(request).where(eq(request.id, requestId)));
      if (row) {
        return { role, request: row };
      }
    } catch {
      // No active grant for this role at all — try the next one.
      continue;
    }
  }
  return null;
}
