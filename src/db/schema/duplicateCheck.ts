import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { duplicateVerdictEnum } from "./enums";
import { request } from "./request";
import { user } from "./user";

// One row per decisive duplicate match actually surfaced to a human — not
// every advisory check that came back empty. matchedRequestId is the
// OTHER, pre-existing request this one matched against; signals records
// which checks fired (e.g. "vendor_invoice_fy", "file_checksum"), plain
// text[] rather than a fixed enum since the signal set is expected to grow
// (perceptual hash, once slice 4 computes it). overriddenBy/reason are
// only ever set together, and only ever lift the application's own
// warning — the structural guarantee is request.one_payment_per_invoice
// and payment.reference's own unique index, neither of which this row can
// touch. For blocked_paid the actor is a super_admin. For matched_advance
// they are the recorded DECLINE of the offer to attach the bill to an open
// advance (concept-v2.html §09), made by whoever was offered it; a
// matched_advance row with overriddenBy null means the offer was surfaced
// and not answered (raised offline) — the accounts desk asks again.
export const duplicateCheck = pgTable(
  "duplicate_check",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => request.id),
    matchedRequestId: uuid("matched_request_id")
      .notNull()
      .references(() => request.id),
    signals: text("signals").array().notNull(),
    // A plain count of which signals fired — not a weighted confidence
    // score, since with only two decisive signals in this slice (vendor+
    // invoice+FY, file checksum) there's nothing meaningful to weight yet.
    // Kept as its own column, matching the brief's schema (concept-v2.html
    // §15), for whichever later signal (a perceptual hash, once slice 4
    // computes one) actually needs one candidate ranked over another.
    score: integer("score").notNull(),
    verdict: duplicateVerdictEnum("verdict").notNull(),
    overriddenBy: uuid("overridden_by").references(() => user.id),
    reason: text("reason"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("duplicate_check_request_id_idx").on(table.requestId), index("duplicate_check_matched_request_id_idx").on(table.matchedRequestId)],
);
