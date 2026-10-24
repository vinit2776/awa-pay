import { and, eq, isNull } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { roleGrant } from "./schema";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set. See .env.example.");
}

// app_runtime connects through Supabase's transaction-mode pooler (port
// 6543) which does not support named prepared statements.
const client = postgres(databaseUrl, { prepare: false });

export type Role = (typeof schema.roleEnum.enumValues)[number];

const ROLES = new Set<Role>(schema.roleEnum.enumValues);

export type ScopedTx = PostgresJsDatabase<typeof schema>;

export class UnauthorizedGrantError extends Error {
  constructor(actorId: string, role: Role) {
    super(`Actor ${actorId} does not hold an active grant for role "${role}".`);
    this.name = "UnauthorizedGrantError";
  }
}

// ---------------------------------------------------------------------
// Why this file is shaped the way it is: round trips are the whole cost.
//
// From a laptop (or a serverless function far from ap-south-1) one network
// round trip to the pooler is 0.3-2 s, so latency ~= round trips x RTT.
// Two facts about postgres.js with `prepare: false` (forced by the pooler)
// drive the design:
//
//   1. A parameterized query ($1, $2 ...) costs TWO round trips: Parse +
//      Describe, then a wait for ParameterDescription, then Bind + Execute.
//      Nothing else can be pipelined behind it meanwhile.
//   2. A query with NO parameters uses the simple protocol: one round trip,
//      and any number of statements can ride in one message
//      ("begin; select ...; select ...").
//
// So everything this file controls is sent as one parameter-free
// multi-statement message. Values that come from the caller (actor id,
// role, presented email/ip/token hash) are therefore inlined, never
// concatenated raw: a UUID is validated against a strict pattern, a role
// against the enum whitelist, and any other string is hex-encoded so the
// only characters that can reach the SQL text are [0-9a-f]. Application
// queries (drizzle) still bind their own parameters as usual.
// ---------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidLiteral(value: string): string {
  if (!UUID.test(value)) throw new Error("Expected a UUID.");
  return `'${value.toLowerCase()}'::uuid`;
}

function roleLiteral(role: Role): string {
  if (!ROLES.has(role)) throw new Error(`Unknown role "${role}".`);
  return `'${role}'`;
}

// Arbitrary text -> a SQL expression that yields exactly that text. Hex is
// injection-proof by construction; convert_from/decode is a fixed cost of a
// few microseconds server-side.
function textLiteral(value: string): string {
  return `convert_from(decode('${Buffer.from(value, "utf8").toString("hex")}', 'hex'), 'UTF8')`;
}

// set_config(name, value, true) is the parameterizable equivalent of SET
// LOCAL: local to the enclosing transaction.
const setActor = (actorId: string) => `select set_config('app.actor_id', ${uuidLiteral(actorId)}::text, true)`;

// The role is bound ONLY if a live grant for it exists, decided by the
// database in the same statement that sets it; otherwise app.actor_role is
// left empty (app_actor_role() reads that as NULL) and every role-gated RLS
// policy fails closed. This replaces the old two-step "set the GUC, then
// SELECT the grant to check it" (assertActiveGrant): the check is still made
// in Postgres, but the role is never asserted before the grant is proven, so
// nothing has to wait on the answer before running fn. Must follow setActor
// in the same transaction: the role_grant SELECT policy only exposes a
// caller's own rows once app.actor_id is set.
const bindRole = (actorId: string, role: Role) =>
  `select set_config('app.actor_role', case when exists (` +
  `select 1 from role_grant where user_id = ${uuidLiteral(actorId)} and role::text = ${roleLiteral(role)} and revoked_at is null` +
  `) then ${roleLiteral(role)} else '' end, true) as bound`;

/**
 * Runs `fn` in one transaction on one reserved connection.
 *
 * `setup` is a parameter-free multi-statement string: it starts with `begin`
 * and sets this transaction's scope GUCs. It is written to the socket ahead
 * of fn's first statement, so BEGIN + scope + fn's first request share a
 * flight instead of costing a round trip each. That is only safe because
 * every setup statement either cannot fail or fails closed:
 *   - if `begin`/set_config failed, the connection is unusable anyway;
 *   - a role that isn't held is never bound (see bindRole), so fn running
 *     alongside an unheld-role check sees no role-gated rows and can write
 *     nothing role-gated. Whatever fn returns or throws in that case is
 *     discarded and the transaction rolled back: `verify` throws instead.
 */
async function scoped<T>(
  setup: string,
  verify: ((setupResults: unknown[]) => void) | null,
  fn: (tx: ScopedTx, conn: postgres.ReservedSql) => Promise<T>,
): Promise<T> {
  const conn = await client.reserve();
  try {
    // drizzle's driver installs its own timestamp/json parsers on
    // `client.options`; only the root client carries that object, so lend it
    // to the reserved handle before wrapping.
    Object.assign(conn, { options: client.options });
    const tx = drizzle(conn, { schema });

    const setupQuery = conn.unsafe(setup).execute();
    let ran: Promise<T>;
    try {
      ran = fn(tx, conn);
    } catch (err) {
      ran = Promise.reject(err);
    }

    const [setupOutcome, fnOutcome] = await Promise.allSettled([setupQuery, ran]);
    if (setupOutcome.status === "rejected") throw setupOutcome.reason;
    verify?.(setupOutcome.value as unknown[]);
    if (fnOutcome.status === "rejected") throw fnOutcome.reason;

    await conn.unsafe("commit");
    return fnOutcome.value;
  } catch (err) {
    await conn.unsafe("rollback").catch(() => undefined);
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * The only way application code may query the database with a role. Binds
 * the caller's identity and the role they're acting as into the transaction
 * and runs `fn` inside it. Every RLS policy re-derives department and
 * company scope live from role_grant, keyed on those two values — this
 * function does not resolve or pass along scope itself, so a bug here can
 * misidentify who's asking but cannot fabricate scope role_grant doesn't
 * actually contain.
 *
 * Throws UnauthorizedGrantError if the actor holds no active grant for
 * `role`. That check is a courtesy (a clear error instead of a confusing
 * empty result set); the boundary itself is that bindRole leaves the role
 * unset unless the grant exists, and RLS fails closed without one.
 */
export async function withGrantScope<T>(
  actorId: string,
  role: Role,
  fn: (tx: ScopedTx) => Promise<T>,
): Promise<T> {
  const setup = `begin; ${setActor(actorId)}; ${bindRole(actorId, role)}`;
  return scoped(
    setup,
    (results) => {
      const bound = (results[2] as { bound?: string }[] | undefined)?.[0]?.bound;
      if (bound !== role) throw new UnauthorizedGrantError(actorId, role);
    },
    (tx) => fn(tx),
  );
}

/**
 * For reads where identity is known but no specific role is being
 * asserted — reading one's own role_grant rows during login (before a
 * role is chosen), creating/updating one's own session row, writing a
 * pre-role-selection event(object_type='auth') row. Sets app.actor_id
 * only; app.actor_role stays unset. Legitimate because role_grant_select's
 * own-row branch (`user_id = app_actor_id()`) doesn't require actor_role —
 * see drizzle/migrations/0001_rls_and_grants.sql.
 */
export async function withActorScope<T>(actorId: string, fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
  return scoped(`begin; ${setActor(actorId)}`, null, (tx) => fn(tx));
}

/**
 * The very first read of the login flow: looking a user up by email
 * before any identity exists at all. Sets app.presented_login_email (and
 * app.presented_client_ip, for the login_attempt rate-limit read) — see
 * the user_select and login_attempt_select policies in
 * drizzle/migrations/0003_auth_rls_and_grants.sql.
 */
export async function withPreAuthLookup<T>(
  presented: { email: string; clientIp: string },
  fn: (tx: ScopedTx) => Promise<T>,
): Promise<T> {
  const setup =
    `begin; select set_config('app.presented_login_email', ${textLiteral(presented.email)}, true), ` +
    `set_config('app.presented_client_ip', ${textLiteral(presented.clientIp)}, true)`;
  return scoped(setup, null, (tx) => fn(tx));
}

/**
 * Session-token verification, before identity is known — the token
 * itself is the credential. Sets app.presented_token_hash — see
 * session_select in drizzle/migrations/0003_auth_rls_and_grants.sql.
 */
export async function withPresentedSessionToken<T>(
  tokenHash: string,
  fn: (tx: ScopedTx) => Promise<T>,
): Promise<T> {
  return scoped(`begin; select set_config('app.presented_token_hash', ${textLiteral(tokenHash)}, true)`, null, (tx) => fn(tx));
}

export type ResolvedViewer<P> = {
  role: Role;
  // Every role the actor holds an active grant for, read in this same
  // transaction — lets a caller answer "does this person also hold X" with
  // no extra query.
  heldRoles: ReadonlySet<Role>;
  probed: P;
};

/**
 * For a caller that doesn't know which of the actor's roles can see a thing
 * — a request detail page, where visibility differs per role and a person
 * can hold several. Replaces "try each role in its own transaction until
 * one returns the row" (up to six transactions) with one transaction: read
 * the actor's active grants, then bind each *held* role in priority order
 * and run `probe` until it returns something. `fn` then runs under that
 * role in the same transaction.
 *
 * RLS remains the arbiter of visibility — `probe` is an ordinary scoped
 * query, and a role is only ever bound if the grant exists (bindRole).
 * Returns null if no held role can see anything.
 */
export async function withViewerRole<P, T>(
  actorId: string,
  candidates: readonly Role[],
  probe: (tx: ScopedTx) => Promise<P | null | undefined>,
  fn: (tx: ScopedTx, viewer: ResolvedViewer<P>) => Promise<T>,
): Promise<T | null> {
  return scoped(`begin; ${setActor(actorId)}`, null, async (tx, conn) => {
    const grants = await tx
      .select({ role: roleGrant.role })
      .from(roleGrant)
      .where(and(eq(roleGrant.userId, actorId), isNull(roleGrant.revokedAt)));
    const heldRoles = new Set<Role>(grants.map((g) => g.role));

    for (const role of candidates) {
      if (!heldRoles.has(role)) continue;
      // Sent ahead of probe's own first statement, so binding costs no
      // extra round trip. Unconditional-looking but still proven: bindRole
      // re-checks the grant in the database.
      const bind = conn.unsafe(bindRole(actorId, role)).execute();
      const probed = await probe(tx);
      const [{ bound }] = (await bind) as unknown as { bound: string }[];
      if (bound !== role) throw new UnauthorizedGrantError(actorId, role);
      if (probed != null) {
        return fn(tx, { role, heldRoles, probed });
      }
    }
    return null;
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
  return scoped("begin", null, (tx) => fn(tx));
}
