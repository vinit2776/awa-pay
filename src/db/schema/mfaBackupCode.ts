import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./user";

// Hashed the same way as passwords (src/auth/password.ts). used_at makes
// each code single-use — set once, never cleared.
export const mfaBackupCode = pgTable(
  "mfa_backup_code",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id),
    codeHash: text("code_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (table) => [index("mfa_backup_code_unused_user_idx").on(table.userId).where(sql`${table.usedAt} is null`)],
);
