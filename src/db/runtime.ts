import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { roleGrant } from "./schema";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set. See .env.example.");
}

// app_runtime connects through Supabase's transaction-mode pooler (port
// 6543, PgBouncer) which does not support prepared statements.
const client = postgres(databaseUrl, { prepare: false });
const db = drizzle(client, { schema });

export type Role = (typeof schema.roleEnum.enumValues)[number];

const ROLES = new Set<Role>(schema.roleEnum.enumValues);

export type ScopedTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

class UnauthorizedGrantError extends Error {
  constructor(actorId: string, role: Role) {
    super(`Actor ${actorId} does not hold an active grant for role "${role}".`);
    this.name = "UnauthorizedGrantError";
  }
}

/**
 * App-side pre-check only — NOT the security boundary. Exists so a
 * developer calling withGrantScope with a role the actor doesn't hold gets
 * a clear error instead of a confusing empty result set. RLS below enforces
 * correctly even if this check were skipped or buggy.
 *
 * Must run inside the scoped transaction, after the GUCs are set: the
 * role_grant SELECT policy only permits reading rows where
 * `user_id = app_actor_id()`, so run before the GUCs exist, this query
 * would itself be RLS-blocked into a false "no grant" negative.
 */
async function assertActiveGrant(tx: ScopedTx, actorId: string, role: Role): Promise<void> {
  const [grant] = await tx
    .select({ id: roleGrant.id })
    .from(roleGrant)
    .where(and(eq(roleGrant.userId, actorId), eq(roleGrant.role, role), isNull(roleGrant.revokedAt)))
    .limit(1);

  if (!grant) {
    throw new UnauthorizedGrantError(actorId, role);
  }
}

/**
 * The only way application code may query the database. Binds the caller's
 * identity and the role they're acting as into the transaction (via
 * set_config(..., true), the parameterizable equivalent of SET LOCAL), then
 * runs `fn` inside that transaction. Every RLS policy re-derives department
 * and company scope live from role_grant, keyed on those two values — this
 * function does not resolve or pass along scope itself, so a bug here can
 * misidentify who's asking but cannot fabricate scope role_grant doesn't
 * actually contain.
 */
export async function withGrantScope<T>(
  actorId: string,
  role: Role,
  fn: (tx: ScopedTx) => Promise<T>,
): Promise<T> {
  if (!ROLES.has(role)) {
    throw new Error(`Unknown role "${role}".`);
  }

  return db.transaction(async (tx) => {
    // set_config(..., true) is the parameterizable equivalent of SET LOCAL —
    // SET itself doesn't accept bind parameters, but set_config is a plain
    // function call and does. true = local to this transaction.
    await tx.execute(sql`select set_config('app.actor_id', ${actorId}, true)`);
    await tx.execute(sql`select set_config('app.actor_role', ${role}, true)`);
    await assertActiveGrant(tx, actorId, role);
    return fn(tx);
  });
}

/**
 * Gate test only — never call from application code. Opens a transaction
 * against DATABASE_URL with neither app.actor_id nor app.actor_role set, to
 * prove RLS fails closed on an unscoped query. See tests/isolation.test.ts.
 */
export async function __unscopedRuntimeConnectionForGateTestOnly<T>(
  fn: (tx: ScopedTx) => Promise<T>,
): Promise<T> {
  return db.transaction(fn);
}
