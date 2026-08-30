// Owner-role client (DATABASE_URL_MIGRATIONS), for seed/fixture scripts and
// tests only. Deliberately outside src/ so nothing under src/app/** can
// import it by accident. Bypasses RLS entirely — never use this for
// anything that should be scope-checked.
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema";

config({ path: ".env.local" });

const databaseUrlMigrations = process.env.DATABASE_URL_MIGRATIONS;
if (!databaseUrlMigrations) {
  throw new Error("DATABASE_URL_MIGRATIONS is not set. See .env.example.");
}

const client = postgres(databaseUrlMigrations);
export const dbOwner = drizzle(client, { schema });

export async function closeOwnerConnection(): Promise<void> {
  await client.end();
}
