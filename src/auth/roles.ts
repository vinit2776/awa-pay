import { and, eq, isNull } from "drizzle-orm";
import type { ScopedTx } from "@/db/runtime";
import { roleGrant } from "@/db/schema";

// The public counterpart to runtime.ts's private assertActiveGrant query —
// runnable under withActorScope, where identity is known but no specific
// role has been asserted yet (login, before the actor picks which desk
// they're using).
export async function getActiveRoleGrants(tx: ScopedTx, actorId: string) {
  return tx
    .select()
    .from(roleGrant)
    .where(and(eq(roleGrant.userId, actorId), isNull(roleGrant.revokedAt)));
}

export async function hasActiveRole(
  tx: ScopedTx,
  actorId: string,
  role: (typeof roleGrant.$inferSelect)["role"],
): Promise<boolean> {
  const grants = await getActiveRoleGrants(tx, actorId);
  return grants.some((g) => g.role === role);
}
