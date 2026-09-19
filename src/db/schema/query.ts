import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { roleEnum } from "./enums";
import { request } from "./request";
import { user } from "./user";

// A query freezes a request in place (src/requests/transitions.ts's
// runTransition refuses every transition while resolved_at IS NULL exists
// for a request) without changing ownership — "the approver still owns the
// request while waiting for an answer" (docs/concept-v2.html §04). Answered
// once, never reopened: resolved_at is the freeze/unfreeze switch.
export const query = pgTable(
  "query",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => request.id),
    raisedBy: uuid("raised_by")
      .notNull()
      .references(() => user.id),
    // Snapshot, matching comment.roleAtTime/event.roleAtTime's convention.
    raisedAsRole: text("raised_as_role").notNull(),
    // A live-enforced value, not a snapshot: query_update's RLS checks
    // app_actor_role() = ANY(directed_at), so this needs real enum typing.
    // Role targets are the department-pool model as everywhere else in
    // this codebase; may be empty when the query names people instead.
    directedAt: roleEnum("directed_at").array().notNull(),
    // Individuals asked by name, alongside or instead of directedAt. Also
    // live-enforced by query_update (app_actor_id() = ANY(directed_user_ids)).
    // An array can't carry a foreign key, so queriesCore validates each id
    // against an active, in-scope grant when the query is raised.
    directedUserIds: uuid("directed_user_ids").array().notNull().default(sql`'{}'`),
    question: text("question").notNull(),
    answeredBy: uuid("answered_by").references(() => user.id),
    answeredAsRole: text("answered_as_role"),
    answer: text("answer"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("query_request_id_idx").on(table.requestId),
    index("query_open_idx").on(table.requestId).where(sql`${table.resolvedAt} is null`),
    // A query is directed at somebody: roles, people, or both.
    check(
      "query_directed_check",
      sql`cardinality(${table.directedAt}) > 0 or cardinality(${table.directedUserIds}) > 0`,
    ),
    // Either fully unanswered or fully answered — never a half-written row
    // (e.g. answer text with no answeredBy).
    check(
      "query_answer_fields_together_check",
      sql`(${table.answeredBy} is null and ${table.answeredAsRole} is null and ${table.answer} is null and ${table.resolvedAt} is null)
        or (${table.answeredBy} is not null and ${table.answeredAsRole} is not null and ${table.answer} is not null and ${table.resolvedAt} is not null)`,
    ),
  ],
);
