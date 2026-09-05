import { index, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { extractionFieldEnum } from "./enums";
import { extractionAttempt } from "./extractionAttempt";
import { user } from "./user";

// One row per field per attempt — "field · value · confidence ·
// accepted_value · corrected_by" (concept-v2.html §15). model isn't
// repeated per field: it lives once on extraction_attempt, since escalation
// re-runs the whole bill, not one field. acceptedValue/correctedBy are
// filled in retroactively by submitRequest, by diffing the final submitted
// values against what's already stored here — never re-queried from the
// model.
export const extraction = pgTable(
  "extraction",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => extractionAttempt.id),
    field: extractionFieldEnum("field").notNull(),
    value: text("value"),
    confidence: real("confidence"),
    acceptedValue: text("accepted_value"),
    correctedBy: uuid("corrected_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("extraction_attempt_id_idx").on(table.attemptId)],
);
