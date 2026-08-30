import { sql } from "drizzle-orm";
import { boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { userStatusEnum } from "./enums";

export const user = pgTable(
  "user",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    status: userStatusEnum("status").notNull().default("active"),
    // argon2id hash. No default — every user must be provisioned with one.
    passwordHash: text("password_hash").notNull(),
    mfaEnrolled: boolean("mfa_enrolled").notNull().default(false),
    // AES-256-GCM(MFA_ENCRYPTION_KEY) over the TOTP seed. Only set once
    // enrollment is confirmed with a valid code — see src/auth/totp.ts.
    mfaSecretEncrypted: text("mfa_secret_encrypted"),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastSeen: timestamp("last_seen", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("user_email_lower_idx").on(sql`lower(${table.email})`)],
);
