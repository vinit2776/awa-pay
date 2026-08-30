import { boolean, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const company = pgTable("company", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  legalName: text("legal_name").notNull(),
  gstin: text("gstin"),
  pan: text("pan"),
  registeredAddress: text("registered_address"),
  bankAccounts: jsonb("bank_accounts").notNull().default([]),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
