import { config } from "dotenv";
import { pointProcessAtTestDatabase } from "../scripts/dbTarget";

config({ path: ".env.local" });

// Isolation from the dev database. src/db/runtime.ts reads DATABASE_URL at
// import time and scripts/db-owner.ts resolves the owner URL itself, so the
// only job here is to (a) fail the run outright if the test database isn't
// configured or is the dev one, and (b) point DATABASE_URL at the test
// runtime role before any test file imports src/db/runtime.ts.
pointProcessAtTestDatabase();

// AGENTS.md rule 4: suppress notification sends under test, so a real
// RESEND_API_KEY in .env.local can never fire mail at fixture addresses.
// src/notifications/email.ts already resolves an unset key to a logged,
// suppressed no-op; this makes that the guaranteed path under vitest.
delete process.env.RESEND_API_KEY;
