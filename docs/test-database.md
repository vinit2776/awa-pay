# Test fixtures and the test database

`npm test` creates and deletes real rows — users, departments, requests, payments — through the real runtime role and RLS, with no mocks. By default it does that in the **dev database**, the same one the dev server and manual walkthroughs use. That is acceptable while there is no real data, but it has a cost worth knowing about, and this doc describes what guards against it.

## The problem this addresses

A fixture user left behind by a crashed run (`desks-test-accountant-…@example.invalid`, still holding an *active* accountant grant) is indistinguishable from a real accountant to `src/notifications/recipients.ts`. With a live `RESEND_API_KEY` in dev, approving a request would mail dead addresses. Fixtures were leaking because each test file's hand-written delete list rotted: new tables (`duplicate_check`, `extraction_attempt`, …) never got added, the first foreign-key error aborted the rest, and the `role_grant` delete sat after the fragile steps.

## What guards against it now

1. **Undeliverable recipients are dropped before sending** (`src/notifications/recipientFilter.ts`, applied in `sendEmail`). Addresses on the domains RFC 2606 reserves — `.invalid`, `.test`, `.example`, `.localhost`, `example.com/.net/.org` — can never be delivered, so fixtures and the `@awa-pay.test` walkthrough accounts cost no send and no bounce, whatever is in the database. Each drop is logged, not silent. (Consequence: walkthrough accounts receive no email either; that mail could only ever bounce.)
2. **Tests cannot send mail.** `tests/setup.ts` deletes `RESEND_API_KEY` from the test process (AGENTS.md rule 4). Before this, a real key in `.env.local` meant `notifications.test.ts` really sent mail to `*.example.invalid`.
3. **Cleanup that cannot quietly leave grants behind.** Every fixture a test creates carries the file's 8-hex-character nonce — in user emails (`…-<nonce>@example.invalid`) and in department, company, head and vendor names/codes. Each file's `afterAll` calls `cleanupFixturesForNonce(dbOwner, nonce)` (`scripts/fixtures.ts`), which:
   - finds everything belonging to that nonce **by name, not by ids held in memory**, so it still works if `beforeAll` died half-way;
   - **revokes the fixture users' grants and deletes their sessions first, as its own committed statement** — so even if everything after it fails, they can't be notification recipients;
   - deletes every dependent row in foreign-key order inside one transaction (all-or-nothing);
   - verifies nothing is left, and **throws** if anything is, naming the nonce and the command to clear it.

   Adding a table a fixture can touch now means one edit in `scripts/fixtures.ts`. `tests/fixtures.test.ts` covers the mechanism.
4. **A loud warning every run** when the suite is using the dev database.

## Sweeping stale fixtures — `npm run db:cleanup-fixtures`

For runs that never reached `afterAll` (Ctrl-C, a killed CI job, a crash) and for any pre-existing pile. **Dry run by default**:

```bash
npm run db:cleanup-fixtures                       # dev database, dry run
```

It lists every matched user (with its active-grant count), department, company, head and vendor, and the requests in fixture departments. It then executes the real delete statements inside a transaction that it **rolls back**, and prints per-table row counts — so what you see is what `--apply` will do, and any foreign key pointing in from real data shows up before anything is committed.

```bash
npm run db:cleanup-fixtures -- --revoke-only      # stop the bleeding: revoke grants + drop sessions, delete nothing
npm run db:cleanup-fixtures -- --apply            # revoke, then delete everything listed
```

- **What matches** is only the naming convention above. Nothing else is selected: not `*@awa-pay.test`, not the `phase*-…`/`wt-…`/`demo`/`approver`/`accountant`/`payer` walkthrough users, not their departments, companies, heads, vendors or requests. A user matching `@awa-pay.test` aborts the run outright.
- **`--min-age-minutes N`** (default 60) skips a whole fixture family (one nonce = one test run) if its *newest* row is younger than N minutes, so a run in progress is not swept from under itself. Because tests share the dev database by default, other people's runs may be in progress: use `--min-age-minutes 0` only when you know nothing is running.
- **All-or-nothing.** If a request outside any fixture department references fixture data, or Postgres refuses a delete, the run stops with the constraint named and changes nothing. `--revoke-only` is the one exception by design: it commits.

## Optional: a separate test database

Not required. To take tests off the dev database entirely, provision another Postgres with the same two-role shape (a second Supabase project, a local Postgres, or a container), set **both** `DATABASE_URL_TEST` (restricted `app_runtime` role) and `DATABASE_URL_MIGRATIONS_TEST` (owner) in `.env.local`, and run `npm run db:migrate:test`. The suite then uses it and **refuses to start** if either URL names the same database as the dev URLs (compared by Supabase project ref, so a different password or port does not disguise it). Setting only one of the two is an error, never a fallback. `npm run db:cleanup-fixtures -- --target test` sweeps it.

The role setup is the same as phase 0: `create role app_runtime login password '…'; grant connect on database <db> to app_runtime; grant usage on schema public to app_runtime;` — migrations grant the rest.

**Use `db:migrate:test`, not `drizzle-kit migrate`, on an empty database.** `drizzle-kit migrate` applies everything in one transaction, and migration `0009` adds the enum value `request_stage = 'withdrawn'` which later migrations use; Postgres refuses (`unsafe use of new value "withdrawn"`). `scripts/migrate-test.ts` commits each migration separately and records it in drizzle's own table. The first production bootstrap will hit the same limit.

## Not isolated

Tests upload small files to the real R2 bucket (`presignPutUrl`), and that bucket is object-locked, so those objects cannot be removed. A separate test bucket with short retention would fix it; it needs a new bucket and token, not code.
