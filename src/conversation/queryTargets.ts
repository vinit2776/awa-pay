import { sql } from "drizzle-orm";
import type { Role, ScopedTx } from "@/db/runtime";
import { CONVERSATION_ROLES } from "./roles";

// Who can be asked a query on a given request: everyone holding an active
// grant, in a conversation role, whose scope covers the request's
// department (and, for a payer or accountant, its company once it has
// one). Answered by app_users_with_scope — SECURITY DEFINER, because
// role_grant_select lets an actor read only their own grants — one call
// per role in a single round trip, so a person holding two roles comes
// back once with both.
//
// Shared by queriesCore.ts (server-side validation of named users — the
// client's list is never trusted) and the request page's picker, so the
// two can't disagree about who is eligible.
export async function queryTargetsFor(
  tx: ScopedTx,
  req: { departmentId: string; companyId: string | null },
): Promise<Map<string, Role[]>> {
  const perRole = CONVERSATION_ROLES.map(
    (role) => sql`select ${role}::text as role, user_id from app_users_with_scope(ARRAY[${role}]::text[], ${req.departmentId}, ${req.companyId})`,
  );
  const rows = await tx.execute<{ role: Role; user_id: string }>(sql.join(perRole, sql` union all `));

  const byUser = new Map<string, Role[]>();
  for (const row of rows) {
    byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), row.role]);
  }
  return byUser;
}
