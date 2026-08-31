import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { request } from "./request";
import { user } from "./user";

// Not append-only via the event hash chain — the brief's own Trail mockup
// (docs/concept-v2.html §07) never shows a comment in it, only structural
// events. This table is its own append-only record instead: no UPDATE
// grant yet (see edited_at below), no DELETE grant ever.
export const comment = pgTable(
  "comment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => request.id),
    author: uuid("author")
      .notNull()
      .references(() => user.id),
    // Snapshot, not a live join to role_grant — same convention as
    // event.roleAtTime: a later grant change never rewrites what the
    // thread displayed at post time.
    roleAtTime: text("role_at_time").notNull(),
    body: text("body").notNull(),
    mentions: uuid("mentions").array().notNull().default([]),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    // Reserved, unwritten this phase — no UPDATE grant exists on this
    // table yet. Editing is a real design question (rewrite in place?
    // flag as edited in the trail? can a mention be silently added or
    // removed after posting?) deferred with a stated reason rather than
    // rushed into a corner of phase 5.
    editedAt: timestamp("edited_at", { withTimezone: true }),
  },
  (table) => [
    index("comment_request_id_idx").on(table.requestId),
    index("comment_mentions_gin_idx").using("gin", table.mentions),
  ],
);
