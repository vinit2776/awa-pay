// Bring the TEST database (DATABASE_URL_MIGRATIONS_TEST) up to date with
// drizzle/migrations. Usage: npm run db:migrate:test
//
// Why not `drizzle-kit migrate`: on an empty database it applies every
// pending migration inside ONE transaction, and 0009 adds the enum value
// request_stage 'withdrawn' which later migrations use — Postgres refuses
// ("unsafe use of new value ... of enum type") until that ALTER TYPE has
// committed. The dev database never hit it because it was migrated one
// slice at a time. A fresh test project can't be, so this applies each
// migration in its own transaction, recording it in drizzle's own
// drizzle.__drizzle_migrations table in drizzle's own format — a later
// `drizzle-kit migrate` against the same database sees them as applied.
//
// Test target only: it takes no URL argument and reads no dev variable.
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { describeUrl, requireTestUrls } from "./dbTarget";

async function main() {
  const { owner } = requireTestUrls();
  console.log(`Migrating test database: ${describeUrl(owner)}`);
  const sql = postgres(owner, { onnotice: () => {}, max: 1 });
  try {
    await sql`create schema if not exists drizzle`;
    await sql`create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`;
    const [last] = await sql<{ created_at: string }[]>`select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`;
    const lastApplied = last ? Number(last.created_at) : -1;

    let applied = 0;
    for (const m of readMigrationFiles({ migrationsFolder: "drizzle/migrations" })) {
      if (m.folderMillis <= lastApplied) continue;
      await sql.begin(async (tx) => {
        for (const statement of m.sql) await tx.unsafe(statement);
        await tx`insert into drizzle.__drizzle_migrations (hash, created_at) values (${m.hash}, ${m.folderMillis})`;
      });
      applied++;
    }
    console.log(applied === 0 ? "Already up to date." : `Applied ${applied} migration(s).`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? `${err.message}${err.cause ? `\n  ${(err.cause as Error).message}` : ""}` : err);
  process.exitCode = 1;
});
