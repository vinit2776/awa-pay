import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { request } from "./request";
import { user } from "./user";

// Append-only: app_runtime is never granted UPDATE or DELETE on this table.
// That revoke lives in drizzle/migrations/0001_rls_and_grants.sql, in the
// same migration that creates it — see AGENTS.md rule 3 and START-HERE.md
// phase 1.
export const event = pgTable(
  "event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id").references(() => request.id),
    actor: uuid("actor")
      .notNull()
      .references(() => user.id),
    roleAtTime: text("role_at_time").notNull(),
    type: text("type").notNull(),
    objectType: text("object_type").notNull(),
    objectId: uuid("object_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    reason: text("reason"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    prevHash: text("prev_hash"),
    hash: text("hash").notNull().unique(),
  },
  (table) => [
    index("event_request_id_idx").on(table.requestId),
    index("event_at_idx").on(table.at),
    index("event_actor_idx").on(table.actor),
  ],
);
