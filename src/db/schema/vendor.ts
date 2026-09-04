import { sql } from "drizzle-orm";
import { boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { headOfAccount } from "./headOfAccount";
import { user } from "./user";

// vendorKey is generated, not application-written: gstin/pan live on this
// same row, so Postgres derives it deterministically on every write with
// no window where it could drift from a hand-maintained duplicate (the
// failure mode named in AGENTS.md rule 7). request.vendorKey (phase 9,
// see request.ts) can't use the same trick — it needs the value from a
// DIFFERENT table, the matched vendor's own key — so that one is written
// by application code instead, inside accountRequest's single combined
// UPDATE.
export const vendor = pgTable(
  "vendor",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    // Free text (e.g. "Partnership firm", "Private limited",
    // "Proprietorship") — no fixed list is named anywhere in the brief.
    type: text("type"),
    gstin: text("gstin"),
    pan: text("pan"),
    udyam: text("udyam"),
    // A section code only (e.g. "194C") — the rate is looked up from
    // src/vendors/tds.ts, a static reference table, never stored here:
    // TDS rates are law, not a vendor attribute, and payment.tdsMinor
    // stays a manual, editable field regardless (see payment.ts).
    tdsSection: text("tds_section"),
    registeredAddress: text("registered_address"),
    contactName: text("contact_name"),
    contactPhone: text("contact_phone"),
    contactEmail: text("contact_email"),
    paymentTermsDays: integer("payment_terms_days"),
    defaultHeadId: uuid("default_head_id").references(() => headOfAccount.id),
    vendorKey: text("vendor_key")
      .notNull()
      .generatedAlwaysAs(sql`coalesce(gstin, pan, id::text)`),
    active: boolean("active").notNull().default(true),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Nullable-safe: a vendor with neither on file doesn't collide with
    // another vendor that also has neither — vendorKey's own id fallback
    // already guarantees that case is unique. These two indexes are the
    // actual concurrency guarantee against two accountants creating "the
    // same" vendor at once — a UI lookup can't stop that race, an index
    // can (AGENTS.md rule 7's reasoning, applied to vendor identity).
    uniqueIndex("vendor_gstin_unique_idx").on(table.gstin).where(sql`${table.gstin} is not null`),
    uniqueIndex("vendor_pan_unique_idx").on(table.pan).where(sql`${table.pan} is not null`),
  ],
);
