import { boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const department = pgTable("department", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  code: text("code").notNull().unique(),
  ageingThresholdDays: integer("ageing_threshold_days").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
