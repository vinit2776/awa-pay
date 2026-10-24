import { config } from "dotenv";
import { pointProcessAtTestDatabase, testDatabaseConfig } from "../scripts/dbTarget";

config({ path: ".env.local" });

// A separate test database is optional (scripts/dbTarget.ts). When it is
// configured, verify it is not the dev one and point DATABASE_URL at it
// before any test file imports src/db/runtime.ts. When it is not, the suite
// runs against the dev database, as it always has — say so, every run, so
// that is never a surprise.
if (testDatabaseConfig() === "isolated") {
  pointProcessAtTestDatabase();
} else {
  // process.stderr, not console.warn: vitest drops console output from setup files.
  process.stderr.write(
    "\n[tests] DATABASE_URL_TEST / DATABASE_URL_MIGRATIONS_TEST are not set: this run uses the DEV database. " +
      "Fixtures are cleaned up in afterAll, but a crashed run can leave grants behind — sweep with `npm run db:cleanup-fixtures`.\n\n",
  );
}

// AGENTS.md rule 4: suppress notification sends under test, so a real
// RESEND_API_KEY in .env.local can never fire mail at fixture addresses.
// src/notifications/email.ts already resolves an unset key to a logged,
// suppressed no-op; this makes that the guaranteed path under vitest.
delete process.env.RESEND_API_KEY;
