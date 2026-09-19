// Which database a script or the test suite talks to, decided in one place.
//
// The vitest suite used to run against the same Supabase project the dev
// server and manual walkthroughs use, so fixture users (and any grants a
// crashed run left behind) showed up in the dev app's queues and
// notification recipient lists. Tests now require their own database —
// DATABASE_URL_TEST (restricted runtime role) and
// DATABASE_URL_MIGRATIONS_TEST (owner role) — and refuse to start if
// either is missing or points at the same database as the dev URLs. There
// is deliberately no fallback to the dev URLs: an unset variable is a hard
// failure, not a silent return to the shared database.
//
// Lives in scripts/, not src/: application code must never see the owner
// connection (AGENTS.md rule 1), and this module names both.
import { config } from "dotenv";

config({ path: ".env.local" });

export type DbTarget = "dev" | "test";

/**
 * Vitest sets VITEST (and NODE_ENV=test). DB_TARGET=test is the explicit
 * opt-in for scripts and drizzle-kit (npm run db:migrate:test,
 * db:cleanup-fixtures -- --target test). Everything else is dev.
 */
export function currentTarget(): DbTarget {
  if (process.env.VITEST || process.env.NODE_ENV === "test") return "test";
  return process.env.DB_TARGET === "test" ? "test" : "dev";
}

/**
 * A stable identity for "which database is this URL", so the dev and test
 * URLs can be compared even though they differ in role and pooler port.
 * Supabase encodes the project ref in the pooler username
 * (`role.<ref>`) or the direct host (`db.<ref>.supabase.co`); anything else
 * (a local Postgres) falls back to host:port/db.
 */
export function dbIdentity(rawUrl: string): string {
  const url = new URL(rawUrl);
  const fromUser = url.username.includes(".") ? decodeURIComponent(url.username).split(".").slice(1).join(".") : null;
  const fromHost = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(url.hostname)?.[1] ?? null;
  const ref = fromUser ?? fromHost;
  return ref ? `supabase:${ref}` : `pg:${url.hostname}:${url.port || "5432"}${url.pathname}`;
}

/** Human-readable, credential-free description of a URL, for log lines. */
export function describeUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  return `${dbIdentity(rawUrl)} (${url.hostname}:${url.port || "5432"}${url.pathname})`;
}

export type TestUrls = { runtime: string; owner: string };

// tests/setup.ts overwrites DATABASE_URL / DATABASE_URL_MIGRATIONS with the
// test values (src/db/runtime.ts reads DATABASE_URL). Before it does, the
// original dev values are parked here, so every later check in the same
// process still compares against what dev really is. Comparing against the
// live env instead would let "test URL identical to dev URL" slip through
// as "already overridden".
const DEV_RUNTIME_SNAPSHOT = "AWA_PRE_TEST_DATABASE_URL";
const DEV_OWNER_SNAPSHOT = "AWA_PRE_TEST_DATABASE_URL_MIGRATIONS";

/**
 * Returns the test database URLs, or throws. Fails closed: no fallback to
 * the dev URLs if a test variable is unset, and a refusal if either test
 * URL names the same database as either dev URL (different role, port or
 * password notwithstanding — see dbIdentity).
 */
export function requireTestUrls(): TestUrls {
  const runtime = process.env.DATABASE_URL_TEST;
  const owner = process.env.DATABASE_URL_MIGRATIONS_TEST;
  if (!runtime || !owner) {
    const missing = [!runtime && "DATABASE_URL_TEST", !owner && "DATABASE_URL_MIGRATIONS_TEST"].filter(Boolean).join(" and ");
    throw new Error(
      `${missing} not set. The test suite creates and deletes real rows and must never run against the shared dev database — ` +
        `provision a separate database and set both variables (see docs/test-database.md and .env.example).`,
    );
  }

  const testIds = new Set([dbIdentity(runtime), dbIdentity(owner)]);
  for (const [name, value] of [
    ["DATABASE_URL", process.env[DEV_RUNTIME_SNAPSHOT] ?? process.env.DATABASE_URL],
    ["DATABASE_URL_MIGRATIONS", process.env[DEV_OWNER_SNAPSHOT] ?? process.env.DATABASE_URL_MIGRATIONS],
  ] as const) {
    if (value && testIds.has(dbIdentity(value))) {
      throw new Error(
        `The test database URLs point at the same database as ${name} (${describeUrl(value)}). ` +
          `Refusing to run: tests must use their own database, not the dev one.`,
      );
    }
  }
  return { runtime, owner };
}

/**
 * For tests/setup.ts: verify the test URLs (throws if unsafe), park the
 * dev values, and point DATABASE_URL / DATABASE_URL_MIGRATIONS at the test
 * database for everything imported afterwards.
 */
export function pointProcessAtTestDatabase(): TestUrls {
  const urls = requireTestUrls();
  process.env[DEV_RUNTIME_SNAPSHOT] ??= process.env.DATABASE_URL ?? "";
  process.env[DEV_OWNER_SNAPSHOT] ??= process.env.DATABASE_URL_MIGRATIONS ?? "";
  process.env.DATABASE_URL = urls.runtime;
  process.env.DATABASE_URL_MIGRATIONS = urls.owner;
  return urls;
}

/** The owner-role URL for the given target. Never falls back across targets. */
export function ownerUrlFor(target: DbTarget): string {
  if (target === "test") return requireTestUrls().owner;
  const url = process.env.DATABASE_URL_MIGRATIONS;
  if (!url) throw new Error("DATABASE_URL_MIGRATIONS is not set. See .env.example.");
  return url;
}
