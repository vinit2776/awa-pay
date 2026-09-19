# The test database

`npm test` creates and deletes real rows — users, departments, requests, payments — through the real runtime role and RLS, with no mocks. That is deliberate (the isolation gate is only worth anything against real Postgres), but it means the suite must never share a database with the dev server or with manual walkthroughs.

It used to. A fixture user left behind by a crashed run (`desks-test-accountant-…@example.invalid`, still holding an *active* accountant grant) is indistinguishable from a real accountant to `src/notifications/recipients.ts`. With a live `RESEND_API_KEY` in dev, approving a request would have mailed dead addresses. The suite now has its own database, refuses to start without it, and cleans up after itself in a way that cannot quietly leave grants behind.

## One-time setup (needs a person — new project, new credentials)

1. **Create a second Supabase project**, e.g. `awa-pay-test`, region `ap-south-1`. The free plan allows two active projects. No data of value ever goes in it.
2. **Create the runtime role**, exactly as phase 0 did for the dev project (SQL editor, as the project's `postgres` owner):

   ```sql
   create role app_runtime login password '<generate one>';
   grant connect on database postgres to app_runtime;
   grant usage on schema public to app_runtime;
   ```

   Migrations grant `app_runtime` everything else, table by table.
3. **Put two connection strings in `.env.local`** — same shapes as `DATABASE_URL` / `DATABASE_URL_MIGRATIONS`, pointing at the *test* project:

   ```
   DATABASE_URL_TEST=            # app_runtime, transaction pooler (6543)
   DATABASE_URL_MIGRATIONS_TEST= # postgres (owner), session pooler (5432) or direct
   ```
4. **Migrate it:** `npm run db:migrate:test` (idempotent; safe to re-run).
5. **CI:** add the same two values as GitHub Actions secrets named `DATABASE_URL_TEST` and `DATABASE_URL_MIGRATIONS_TEST`. `.github/workflows/ci.yml` uses only these — CI no longer needs the dev project's database secrets, and they can be removed from the repository's secrets once this has merged.

## Why `db:migrate:test` and not `drizzle-kit migrate`

On an empty database `drizzle-kit migrate` applies every migration in **one transaction**. Migration `0009` adds the enum value `request_stage = 'withdrawn'`, which later migrations use, and Postgres refuses to use a new enum value inside the transaction that added it (`unsafe use of new value "withdrawn"`). The dev database never hit this because it was migrated one slice at a time. `scripts/migrate-test.ts` applies each migration in its own transaction and records it in drizzle's own `__drizzle_migrations` table, so the two tools agree about what has been applied. The same limitation will bite the first production bootstrap — worth remembering then.

## What the guard does

`tests/setup.ts` runs before every test file and throws — failing the whole run — if:

- `DATABASE_URL_TEST` or `DATABASE_URL_MIGRATIONS_TEST` is unset (there is no fallback to the dev URLs), or
- either names the same database as `DATABASE_URL` / `DATABASE_URL_MIGRATIONS`. Databases are compared by Supabase project ref (`role.<ref>` in a pooler username, `db.<ref>.supabase.co` for direct), so a different password, role or port does not disguise the dev project.

`scripts/db-owner.ts` independently resolves to the test owner URL under Vitest, so the owner client cannot reach dev even if the setup file were bypassed. `setup.ts` also deletes `RESEND_API_KEY` from the test process (AGENTS.md rule 4) — before this, a real key in `.env.local` meant `notifications.test.ts` really sent mail to `*.example.invalid`.

## How test cleanup works now

Every fixture a test creates carries the file's 8-hex-character nonce — in user emails (`…-<nonce>@example.invalid`) and in department, company, head and vendor names/codes. Each file's `afterAll` calls `cleanupFixturesForNonce(dbOwner, nonce)` (`scripts/fixtures.ts`), which:

1. finds everything belonging to that nonce **by name, not by ids held in memory** — so it still works if `beforeAll` died half-way and no ids were ever assigned;
2. **revokes the fixture users' grants and deletes their sessions first, as its own committed statement** — the part that matters for notifications happens even if everything after it fails;
3. deletes every dependent row in foreign-key order inside one transaction (all-or-nothing);
4. verifies nothing is left, and **throws** if anything is, with the nonce and the command to clear it.

The old per-file delete lists rotted: new tables (`duplicate_check`, `extraction_attempt`, …) never got added, the first foreign-key error aborted the rest, and the `role_grant` delete sat after the fragile ones — which is how 24 fixture users came to hold active grants in dev. Adding a table that a fixture can touch now means one edit in `scripts/fixtures.ts`, and `tests/fixtures.test.ts` covers the mechanism itself.

## Sweeping stale fixtures — `npm run db:cleanup-fixtures`

For runs that never reached `afterAll` (Ctrl-C, a killed CI job, a crash) and for the pre-existing pile in dev. **Dry run by default**:

```bash
npm run db:cleanup-fixtures                       # dev database, dry run
npm run db:cleanup-fixtures -- --target test      # test database, dry run
```

It lists every matched user (with its active-grant count), department, company, head and vendor, and the requests in fixture departments. It then executes the real delete statements inside a transaction that it **rolls back**, and prints the per-table row counts — so what you see is what `--apply` will do, and any foreign key pointing in from real data shows up before anything is committed.

```bash
npm run db:cleanup-fixtures -- --revoke-only      # stop the bleeding: revoke grants + drop sessions, delete nothing
npm run db:cleanup-fixtures -- --apply            # revoke, then delete everything listed
```

- **What matches** is only the naming convention above. Nothing else is selected: not `*@awa-pay.test`, not the `phase*-…`/`wt-…`/`demo`/`approver`/`accountant`/`payer` walkthrough users, not their departments, companies, heads, vendors or requests. A user matching `@awa-pay.test` aborts the run outright.
- **`--min-age-minutes N`** (default 60) skips a whole fixture family (one nonce = one test run) if its *newest* row is younger than N minutes, so a run in progress is not swept from under itself. `--min-age-minutes 0` disables that — only use it when no test run is active.
- **All-or-nothing.** If a request outside any fixture department references fixture data, or Postgres refuses a delete, the run stops with the constraint named and changes nothing. `--revoke-only` is the one exception by design: it commits.
- Vendors and requests are deleted, not archived. The `event` trail rows of *fixture* requests go with them; events of real requests are never touched.

## Not isolated (yet)

Tests still upload small files to the real R2 bucket (`presignPutUrl`), and that bucket is object-locked, so those objects cannot be removed. A separate test bucket with a short retention would fix it; it was left out of this change because it needs a new bucket and token, not code.
