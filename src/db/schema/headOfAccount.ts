import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// A small admin-seeded reference table, matching how department/company are
// already modeled here — not an enum (needs to be curatable per org), not
// free text (needs to stay queryable/reportable). The brief's "suggested
// from the vendor's last 3 bookings" needs vendor master data (slice 3) —
// skipped here, not faked.
export const headOfAccount = pgTable("head_of_account", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  code: text("code").notNull().unique(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
