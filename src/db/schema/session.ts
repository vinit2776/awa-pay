import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user } from "./user";

// token_hash is SHA-256(rawToken) — the raw token never touches the
// database, only its hash (see src/auth/session.ts). pending_mfa sessions
// exist only between a correct password and a verified TOTP code for
// payer-role accounts; everyone else goes straight to active.
export const session = pgTable(
  "session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id),
    tokenHash: text("token_hash").notNull().unique(),
    status: text("status").notNull().default("pending_mfa"),
    mfaAttempts: integer("mfa_attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (table) => [
    index("session_user_id_idx").on(table.userId),
    check("session_status_check", sql`${table.status} in ('pending_mfa', 'active')`),
  ],
);
