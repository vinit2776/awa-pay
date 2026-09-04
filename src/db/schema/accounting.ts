import { date, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { company } from "./company";
import { headOfAccount } from "./headOfAccount";
import { request } from "./request";
import { user } from "./user";
import { vendor } from "./vendor";

// vendor_id is required as of phase 9: "head, voucher, company. Vendor
// matched or created" (AGENTS.md's own lifecycle description of this
// stage). request.vendor (free text, from phase 3 capture) is never
// rewritten — it stays a historical snapshot of what the requester typed;
// this column is the real relational link. No voucher uniqueness: no
// numbering scheme is specified anywhere; don't invent one.
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
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendor.id),
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
