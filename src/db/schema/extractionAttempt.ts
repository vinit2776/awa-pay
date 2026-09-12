import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { extractionAttemptStatusEnum } from "./enums";
import { request } from "./request";
import { user } from "./user";

// Keyed by the uploaded file, not the request — the request doesn't exist
// yet when extraction runs (capture happens before submit; see
// captureCore.ts's own comment on why a fresh capture never sits in
// 'raised'). requestId starts null and is backfilled by submitRequest,
// inside its existing transaction, only for whichever attempt actually
// gets submitted. An attempt whose requestId stays null is either still in
// progress or abandoned — the entire mechanism behind measuring
// abandonment ("the number that matters," per the brief) without any
// separate tracking.
export const extractionAttempt = pgTable(
  "extraction_attempt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storageKey: text("storage_key").notNull(),
    attemptedBy: uuid("attempted_by")
      .notNull()
      .references(() => user.id),
    requestId: uuid("request_id").references(() => request.id),
    status: extractionAttemptStatusEnum("status").notNull(),
    // The tier that actually produced the stored field values — always
    // the escalated tier's output when escalated is true, never both
    // tiers merged field-by-field (see extractCore.ts).
    model: text("model"),
    escalated: boolean("escalated").notNull().default(false),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("extraction_attempt_storage_key_idx").on(table.storageKey),
    index("extraction_attempt_attempted_by_idx").on(table.attemptedBy),
    index("extraction_attempt_request_id_idx").on(table.requestId),
  ],
);
