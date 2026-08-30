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
import { department } from "./department";
import { requestStageEnum } from "./enums";
import { user } from "./user";

// TODO(slice-3): invoice_key, vendor_key, fy and flags arrive once the vendor
// master exists. They exist in the full brief (docs/concept-v2.html §15) only
// to support the (vendor_key, invoice_key, fy) WHERE stage = 'paid' duplicate
// index — meaningless without a vendor master. Until then this table stores a
// plain-text vendor name and cannot fully prevent paying the same bill twice.
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
    note: text("note"),
    closeReason: text("close_reason"),
    holdReviewOn: date("hold_review_on"),
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
