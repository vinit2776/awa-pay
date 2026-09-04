import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { company } from "./company";
import { department } from "./department";
import { holdSubReasonEnum, requestStageEnum } from "./enums";
import { user } from "./user";

// TODO(slice-3, phase 11): invoice_key, fy and flags arrive once duplicate
// control is built. They exist in the full brief (docs/concept-v2.html §15)
// only to support the (vendor_key, invoice_key, fy) WHERE stage = 'paid'
// duplicate index. vendor_key itself lands in phase 9, below — a plain
// nullable column, not generated (unlike vendor.vendor_key): it needs a
// value from the matched vendor's own row, which a generated column can't
// reach across to, so accountRequest (src/requests/transitions.ts) writes
// it at the application layer instead, once accounting picks a vendor.
export const request = pgTable(
  "request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ref: text("ref").notNull().unique(),
    revision: integer("revision").notNull().default(1),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => department.id),
    raisedBy: uuid("raised_by")
      .notNull()
      .references(() => user.id),
    stage: requestStageEnum("stage").notNull().default("raised"),
    currency: text("currency").notNull().default("INR"),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    invoiceNo: text("invoice_no"),
    invoiceDate: date("invoice_date"),
    vendor: text("vendor"),
    // Written once by accountRequest, resolved from the matched vendor's
    // own generated vendor_key column — see the TODO above for why this
    // one is plain rather than generated.
    vendorKey: text("vendor_key"),
    note: text("note"),
    closeReason: text("close_reason"),
    holdReviewOn: date("hold_review_on"),
    holdSubReason: holdSubReasonEnum("hold_sub_reason"),
    // Cached/derived, set by the account transition (src/requests/transitions.ts)
    // — same pattern as `stage` itself: the accounting row is the truth,
    // this is what keeps the payer's queue and RLS company-scoping fast
    // without a correlated subquery through `accounting` on every read.
    companyId: uuid("company_id").references(() => company.id),
    linkedRequest: uuid("linked_request").references((): AnyPgColumn => request.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("request_department_stage_idx").on(table.departmentId, table.stage),
    index("request_raised_by_idx").on(table.raisedBy),
    index("request_linked_request_idx").on(table.linkedRequest),
    check("request_amount_minor_positive_check", sql`${table.amountMinor} > 0`),
  ],
);
