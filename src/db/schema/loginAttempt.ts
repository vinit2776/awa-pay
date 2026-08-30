import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Deliberately not the event table: event.actor is NOT NULL, but an
// unknown-email login attempt has no user row to reference at all. This is
// the pre-identity audit trail — no FK, IP-centric — and doubles as the
// source for rate limiting (src/auth/rateLimit.ts).
export const loginAttempt = pgTable(
  "login_attempt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    ip: text("ip").notNull(),
    userAgent: text("user_agent"),
    succeeded: boolean("succeeded").notNull(),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("login_attempt_email_created_idx").on(table.email, table.createdAt),
    index("login_attempt_ip_created_idx").on(table.ip, table.createdAt),
    check(
      "login_attempt_failure_reason_check",
      sql`${table.failureReason} is null or ${table.failureReason} in ('no_such_user', 'disabled', 'locked', 'bad_password', 'bad_mfa', 'bad_backup_code')`,
    ),
  ],
);
