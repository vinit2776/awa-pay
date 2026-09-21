// Owner-role client, for seed/fixture scripts and tests only. Deliberately
// outside src/ so nothing under src/app/** can import it by accident.
// Bypasses RLS entirely — never use this for anything that should be
// scope-checked.
//
// Under vitest (or DB_TARGET=test) this connects to the TEST database
// (DATABASE_URL_MIGRATIONS_TEST) and refuses to fall back to the dev one —
// see scripts/dbTarget.ts. Otherwise it is DATABASE_URL_MIGRATIONS as before.
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import { currentTarget, ownerUrlFor } from "./dbTarget";

export const ownerTarget = currentTarget();

const client = postgres(ownerUrlFor(ownerTarget));
export const dbOwner = drizzle(client, { schema });

export type OwnerDb = typeof dbOwner;

export async function closeOwnerConnection(): Promise<void> {
  await client.end();
}
