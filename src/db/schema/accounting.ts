import { date, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { company } from "./company";
import { headOfAccount } from "./headOfAccount";
import { request } from "./request";
import { user } from "./user";

// No vendor column: request.vendor (free text, from phase 3 capture) is
// used as-is — vendor matching/creation is slice-3 territory. No voucher
// uniqueness: no numbering scheme is specified anywhere; don't invent one.
//
// Deliberately no unique constraint on request_id. A payer's "return to
// accounts" (vendor bank mismatch) needs a *new* accounting row after
// correction, not an update — these rows are immutable, like
// request_file's evidence columns. "Current" accounting for a request is
// the latest row by accountedAt, mirroring how request.stage caches the
// append-only truth.
export const accounting = pgTable(
  "accounting",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => request.id),
    companyId: uuid("company_id")
      .notNull()
      .references(() => company.id),
    headId: uuid("head_id")
      .notNull()
      .references(() => headOfAccount.id),
    voucherNo: text("voucher_no").notNull(),
    bookedOn: date("booked_on").notNull(),
    accountedBy: uuid("accounted_by")
      .notNull()
      .references(() => user.id),
    accountedAt: timestamp("accounted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("accounting_request_id_idx").on(table.requestId)],
);
