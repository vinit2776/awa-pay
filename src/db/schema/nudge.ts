import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { roleEnum } from "./enums";
import { request } from "./request";
import { user } from "./user";

// "Any update?" shouldn't cost a paragraph — a nudge is aimed at whoever
// currently owns the stage (src/requests/stageOwner.ts's STAGE_OWNER_ROLE),
// rate-limited to one per person per request per day, and appears in the
// Trail via src/events/append.ts. Append-only: no UPDATE/DELETE grant.
export const nudge = pgTable(
  "nudge",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => request.id),
    fromUser: uuid("from_user")
      .notNull()
      .references(() => user.id),
    // Snapshot, matching comment.roleAtTime/query.raisedAsRole's
    // convention.
    fromRole: text("from_role").notNull(),
    // Not a snapshot of the actor's own role — this is the target the
    // nudge is aimed at (whichever role STAGE_OWNER_ROLE says currently
    // owns the request's stage), so real enum typing catches a typo'd
    // role the same way directedAt does on query.
    toRole: roleEnum("to_role").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("nudge_request_id_idx").on(table.requestId),
    // AGENTS.md rule 7's own precedent, applied here: the rate limit is a
    // database constraint, not a UI check — two simultaneous nudges from
    // the same person race the same way two simultaneous bill submits do.
    // Asia/Kolkata explicitly, not the session/UTC default: this is an
    // India-only org, and "once a day" should mean an IST calendar day,
    // not a UTC one that flips at 5:30am local time.
    uniqueIndex("nudge_one_per_person_per_request_per_day_idx").on(
      table.fromUser,
      table.requestId,
      sql`((${table.at} AT TIME ZONE 'Asia/Kolkata')::date)`,
    ),
  ],
);
