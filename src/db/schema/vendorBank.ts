import { sql } from "drizzle-orm";
import { check, date, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { roleEnum } from "./enums";
import { user } from "./user";
import { vendor } from "./vendor";

// Versioned like accounting: never updated, only superseded — a new row is
// what makes a bank change detectable (concept-v2.html §10's own "bank
// changes are an event" note). Exactly one current row per vendor
// (superseded_at IS NULL) is the partial unique index below, guarded
// against a concurrent supersede-then-insert race by src/vendors/lock.ts's
// lockVendorMutex. Phase 10's payer-verification precondition reads that
// current row's verifiedAt — the entire "a bank change flags every open
// request" mechanism is this one live read, no per-request cached flag.
export const vendorBank = pgTable(
  "vendor_bank",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendor.id),
    beneficiaryName: text("beneficiary_name").notNull(),
    // AES-256-GCM via src/vendors/crypto.ts — mirrors src/auth/crypto.ts's
    // mfa_secret_encrypted column exactly. Only the last 4 digits are ever
    // stored in plaintext, so nothing needs to decrypt just to render a
    // masked account number.
    accountNumberEncrypted: text("account_number_encrypted").notNull(),
    accountNumberLast4: text("account_number_last4").notNull(),
    ifsc: text("ifsc").notNull(),
    branch: text("branch"),
    effectiveFrom: date("effective_from").notNull(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    enteredBy: uuid("entered_by")
      .notNull()
      .references(() => user.id),
    // Snapshot, matching query.raisedAsRole's convention — distinguishes
    // the accountant's normal entry path from the payer's narrow,
    // self-verified correction path (phase 10) in the record itself, not
    // just in which RLS policy happened to allow the INSERT.
    enteredAsRole: roleEnum("entered_as_role").notNull(),
    verifiedBy: uuid("verified_by").references(() => user.id),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
  },
  (table) => [
    index("vendor_bank_vendor_id_idx").on(table.vendorId),
    uniqueIndex("vendor_bank_current_unique_idx").on(table.vendorId).where(sql`${table.supersededAt} is null`),
    check("vendor_bank_last4_length_check", sql`char_length(${table.accountNumberLast4}) = 4`),
  ],
);
