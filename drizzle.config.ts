// drizzle-kit is a standalone CLI — Next's automatic .env.local loading does
// not apply outside `next dev`/`next build`, so this loads it explicitly.
import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: ".env.local" });

const databaseUrlMigrations = process.env.DATABASE_URL_MIGRATIONS;
if (!databaseUrlMigrations) {
  throw new Error("DATABASE_URL_MIGRATIONS is not set. See .env.example.");
}

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: { url: databaseUrlMigrations },
});
