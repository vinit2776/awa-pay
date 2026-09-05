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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { company } from "./company";
import { department } from "./department";
import { holdSubReasonEnum, requestStageEnum } from "./enums";
import { user } from "./user";

// Flags (ageing/query/due-date/repeat-amount/bank-changed, phase 12) are
// computed on-demand at render time (src/flags/computeFlags.ts) — dueDate
// below is the one exception, cached for the same reason stage/companyId
// already are: it lives in event.after jsonb (the approve event) and a
// queue rendering N rows can't afford an event scan per row just to sort
// and display it.
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
    // The GSTIN printed on the bill itself, as read off by extraction or
    // typed by the requester (phase 13) — distinct from vendor.gstin,
    // which is the vendor master's own on-file registration and may not
    // exist yet at capture time.
    gstinOnBill: text("gstin_on_bill"),
    // Written once by accountRequest, resolved from the matched vendor's
    // own generated vendor_key column — plain, not generated, since it
    // needs a value from a DIFFERENT table (the matched vendor's own
    // key), which a generated column can't reach across to.
    vendorKey: text("vendor_key"),
    // Generated (phase 11): normalized (trimmed, uppercased, blank ->
    // null) so a stray space or a lowercase 'inv' doesn't defeat the
    // (vendor_key, invoice_key, fy) duplicate index below. Together with
    // vendor_key and fy, this is what the brief calls "the three key
    // columns... generated, indexed, and the basis of every duplicate
    // verdict" (concept-v2.html §15).
    invoiceKey: text("invoice_key").generatedAlwaysAs(sql`nullif(upper(trim(invoice_no)), '')`),
    // Generated via the financial_year() SQL function (0017) — April to
    // March, the Indian FY. Must be IMMUTABLE to be usable in a generated
    // column expression at all; created before this table's own ALTER in
    // the same migration for exactly that reason.
    fy: text("fy").generatedAlwaysAs(sql`financial_year(invoice_date)`),
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
    // Set only when this request was raised via the reconsideration flow
    // (linked_request pointing at a rejected original) — resolved from
    // that original's own hash-chained 'request.rejected' event
    // (event.actor already IS the approver who declined it, so this needs
    // no new lookup capability). A soft routing hint only, never
    // enforcement: a banner and a queue-sort nudge for the approver pool,
    // not a per-user assignment — see docs/START-HERE-slice-3.md finding
    // #1 for why not the latter.
    routedApproverId: uuid("routed_approver_id").references(() => user.id),
    // Set by approveRequest when cycle is "dated" (null for
    // unspecified/immediate), cleared by returnRequestToRequester. The
    // only flag-relevant field cached on this row — see the comment
    // above. No RLS change needed: the existing per-role request_update
    // policies already cover every column on this table, not a named
    // subset.
    dueDate: date("due_date"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("request_department_stage_idx").on(table.departmentId, table.stage),
    index("request_raised_by_idx").on(table.raisedBy),
    index("request_linked_request_idx").on(table.linkedRequest),
    check("request_amount_minor_positive_check", sql`${table.amountMinor} > 0`),
    // AGENTS.md rule 7, verbatim: "A partial unique index on (vendor_key,
    // invoice_key, fy) WHERE stage = 'paid'." The actual, unbypassable
    // guarantee — a UI lookup or an application-layer check can't stop two
    // simultaneous submits from both reaching this INSERT/UPDATE; this
    // index can. Deliberately only bites once all three key columns are
    // non-null (Postgres treats NULL as distinct from NULL in a unique
    // index) and the row has actually reached 'paid' — a request with no
    // invoice number/date on file simply isn't deduplicated by this
    // signal, an accepted limitation rather than a false block.
    uniqueIndex("one_payment_per_invoice").on(table.vendorKey, table.invoiceKey, table.fy).where(sql`${table.stage} = 'paid'`),
  ],
);
