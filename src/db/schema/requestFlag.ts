import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { request } from "./request";
import { user } from "./user";

// A flag a person raises by hand on a request, as opposed to the computed
// flags (src/flags/computeFlags.ts), which are derived at render time and
// can never be set or cleared by anyone. A manual flag says "a human looked
// at this and something is off", with their reason. It does not move the
// request or freeze it: that is what a query is for. Cleared, never deleted,
// so the history of what was flagged and who cleared it survives.
export const requestFlag = pgTable(
  "request_flag",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => request.id),
    raisedBy: uuid("raised_by")
      .notNull()
      .references(() => user.id),
    // Snapshot, matching comment.roleAtTime's convention.
    raisedAsRole: text("raised_as_role").notNull(),
    reason: text("reason").notNull(),
    raisedAt: timestamp("raised_at", { withTimezone: true }).notNull().defaultNow(),
    clearedBy: uuid("cleared_by").references(() => user.id),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
  },
  (table) => [index("request_flag_request_id_idx").on(table.requestId)],
);
