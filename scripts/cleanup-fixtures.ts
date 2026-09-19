// One-off sweep of stale test fixtures — users, departments, companies,
// heads, vendors and every request/row hanging off them — matched by the
// naming convention the test suite uses (see scripts/fixtures.ts for the
// exact rules). Never touches the named walkthrough accounts
// (*@awa-pay.test) or anything that doesn't carry a fixture nonce.
//
// Dry-run by default: prints what it found and executes the real delete
// statements inside a transaction it then rolls back, so the per-table row
// counts (and any foreign-key entanglement) are exactly what --apply would
// hit. Nothing is changed unless --apply (or --revoke-only) is given.
//
// Usage: npx tsx scripts/cleanup-fixtures.ts [options]
//   --target dev|test        which database (default: dev)
//   --apply                  delete everything found (revokes grants first)
//   --revoke-only            only revoke active grants + delete sessions of
//                            fixture users; delete nothing else
//   --min-age-minutes N      skip fixtures newer than N minutes, so a run in
//                            flight isn't swept from under itself (default 60)
import type { DbTarget } from "./dbTarget";
import { describeUrl, ownerUrlFor } from "./dbTarget";
import { ForeignReferenceError, findFixtures, isEmpty, purgeFixtures, revokeFixtureAccess, type FixtureSet } from "./fixtures";

type Args = { target: DbTarget; apply: boolean; revokeOnly: boolean; minAgeMinutes: number };

function parseArgs(argv: string[]): Args {
  const args: Args = { target: "dev", apply: false, revokeOnly: false, minAgeMinutes: 60 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--revoke-only") args.revokeOnly = true;
    else if (a === "--target") {
      const v = argv[++i];
      if (v !== "dev" && v !== "test") throw new Error(`--target must be dev or test, got ${JSON.stringify(v)}`);
      args.target = v;
    } else if (a === "--min-age-minutes") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 0) throw new Error("--min-age-minutes must be a non-negative number");
      args.minAgeMinutes = n;
    } else throw new Error(`Unknown argument ${JSON.stringify(a)}. See the usage comment at the top of this file.`);
  }
  if (args.apply && args.revokeOnly) throw new Error("Pass either --apply or --revoke-only, not both.");
  return args;
}

function report(set: FixtureSet) {
  console.log(`\nUsers (${set.users.length}):`);
  for (const u of set.users) console.log(`  ${u.email}  active grants: ${u.activeGrants}  created ${u.createdAt.toISOString()}`);
  const activeTotal = set.users.reduce((n, u) => n + u.activeGrants, 0);
  console.log(`  -> ${set.users.filter((u) => u.activeGrants > 0).length} user(s) hold ${activeTotal} ACTIVE grant(s)`);

  console.log(`\nDepartments (${set.departments.length}):`);
  for (const d of set.departments) console.log(`  ${d.name}  [${d.code}]`);
  console.log(`\nCompanies (${set.companies.length}):`);
  for (const c of set.companies) console.log(`  ${c.name}`);
  console.log(`\nHeads of account (${set.heads.length}):`);
  for (const h of set.heads) console.log(`  ${h.name}  [${h.code}]`);
  console.log(`\nVendors (${set.vendors.length}):`);
  for (const v of set.vendors) console.log(`  ${v.name}`);

  const byStage = new Map<string, number>();
  for (const r of set.requests) byStage.set(r.stage, (byStage.get(r.stage) ?? 0) + 1);
  console.log(`\nRequests in fixture departments (${set.requests.length}): ${[...byStage].map(([s, n]) => `${s}=${n}`).join(", ") || "none"}`);

  if (set.foreignRequests.length > 0) {
    console.log(`\n!! ${set.foreignRequests.length} request(s) OUTSIDE fixture departments reference fixture data — deletion is blocked:`);
    for (const r of set.foreignRequests) console.log(`     ${r.ref} (${r.stage}) department ${r.departmentId}`);
  }
  if (set.danglingGrantCount > 0) {
    console.log(`\n!  ${set.danglingGrantCount} grant(s) held by non-fixture users list a fixture department/company in their scope; those ids will dangle after delete.`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // db-owner.ts resolves its target once, at import — set it first.
  process.env.DB_TARGET = args.target;
  console.log(`Target: ${args.target} -> ${describeUrl(ownerUrlFor(args.target))}`);
  const { dbOwner, closeOwnerConnection } = await import("./db-owner");

  try {
    const olderThan = new Date(Date.now() - args.minAgeMinutes * 60_000);
    const set = await findFixtures(dbOwner, { olderThan });
    console.log(`Mode: ${args.apply ? "APPLY (delete)" : args.revokeOnly ? "REVOKE-ONLY" : "dry run"}; skipping fixtures newer than ${args.minAgeMinutes} min`);
    if (isEmpty(set)) {
      console.log("\nNo stale fixtures found.");
      return;
    }
    report(set);

    if (args.revokeOnly) {
      const r = await revokeFixtureAccess(dbOwner, set);
      console.log(`\nRevoked ${r.grantsRevoked} active grant(s), deleted ${r.sessionsDeleted} session(s). Nothing else changed.`);
      return;
    }

    if (set.foreignRequests.length > 0) {
      process.exitCode = 2;
      throw new ForeignReferenceError(set.foreignRequests);
    }

    if (!args.apply) {
      const counts = await purgeFixtures(dbOwner, set, { dryRun: true });
      console.log("\nWould delete (dry run — executed and rolled back, nothing changed):");
      for (const [table, n] of Object.entries(counts)) console.log(`  ${table.padEnd(20)} ${n}`);
      console.log("\nRe-run with --apply to delete, or --revoke-only to just cut off access.");
      return;
    }

    const revoked = await revokeFixtureAccess(dbOwner, set);
    console.log(`\nRevoked ${revoked.grantsRevoked} active grant(s), deleted ${revoked.sessionsDeleted} session(s).`);
    const counts = await purgeFixtures(dbOwner, set);
    console.log("Deleted:");
    for (const [table, n] of Object.entries(counts)) console.log(`  ${table.padEnd(20)} ${n}`);
  } finally {
    await closeOwnerConnection();
  }
}

// drizzle wraps driver errors as "Failed query: ..." and hides Postgres's own
// message (which constraint, which table) in `cause` — that is the part an
// operator needs when a foreign key blocks the delete.
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause as { message?: string; detail?: string; table_name?: string; constraint_name?: string } | undefined;
  if (!cause?.message) return err.message;
  return [cause.message, cause.detail, cause.constraint_name && `constraint: ${cause.constraint_name}`, cause.table_name && `table: ${cause.table_name}`]
    .filter(Boolean)
    .join("\n  ");
}

main().catch((err) => {
  console.error(describeError(err));
  process.exitCode ||= 1;
});
