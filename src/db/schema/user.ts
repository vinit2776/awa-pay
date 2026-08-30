import { sql } from "drizzle-orm";
import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { userStatusEnum } from "./enums";

export const user = pgTable(
  "user",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    status: userStatusEnum("status").notNull().default("active"),
    mfaEnrolled: boolean("mfa_enrolled").notNull().default(false),
    lastSeen: timestamp("last_seen", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("user_email_lower_idx").on(sql`lower(${table.email})`)],
);
