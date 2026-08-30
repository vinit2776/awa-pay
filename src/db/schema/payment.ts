import { sql } from "drizzle-orm";
import { bigint, check, date, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { paymentModeEnum } from "./enums";
import { request } from "./request";
import { user } from "./user";

// UNIQUE(request_id): phase 4 supports exactly one full payment per
// request, moving straight to stage='paid'. AGENTS.md's "accepts more than
// one until its balance is zero" describes the settlement-ledger vision
// (concept-v2.html §09) — a distinct, bigger feature, deferred. This index
// makes that scope cut structural, not just a UI convention.
//
// UNIQUE(reference) is AGENTS.md rule 7, verbatim: "a unique index on the
// payment reference." This table didn't exist until now; this is where
// that already-decided rule becomes real.
//
// tds_minor is a plain, manually-entered, editable integer — not computed.
// The brief's "computed from the vendor's section and rate" needs vendor
// master data that doesn't exist until slice 3.
//
// from_account is a jsonb snapshot of one entry from company.bank_accounts
// (see src/lib/bankAccounts.ts for the documented shape), copied in whole
// at pay time — not a live reference — so a payment stays exactly what was
// actually used even if the company's account list changes later. "A
// payment is immutable once recorded" (AGENTS.md).
export const payment = pgTable(
  "payment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => request.id),
    fromAccount: jsonb("from_account").notNull(),
    mode: paymentModeEnum("mode").notNull(),
    valueDate: date("value_date").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    tdsMinor: bigint("tds_minor", { mode: "number" }).notNull().default(0),
    reference: text("reference").notNull(),
    paidBy: uuid("paid_by")
      .notNull()
      .references(() => user.id),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("payment_request_id_unique_idx").on(table.requestId),
    uniqueIndex("payment_reference_unique_idx").on(table.reference),
    check("payment_amount_minor_positive_check", sql`${table.amountMinor} > 0`),
    check("payment_tds_minor_nonneg_check", sql`${table.tdsMinor} >= 0`),
    check("payment_reference_not_blank_check", sql`char_length(${table.reference}) > 0`),
  ],
);
