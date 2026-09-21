import { relations } from "drizzle-orm";
import { accounting } from "./accounting";
import { comment } from "./comment";
import { department } from "./department";
import { event } from "./event";
import { payment } from "./payment";
import { query } from "./query";
import { request } from "./request";
import { roleGrant } from "./roleGrant";
import { requestFile } from "./requestFile";
import { user } from "./user";

// Relations exist for one reason: drizzle's relational query API compiles a
// request and everything hanging off it into a single statement, so the
// request detail page pays two round trips for its reads instead of two per
// table (see src/requests/requestView.ts). They add no constraints and need
// no migration. Row-level security still applies to every nested table
// inside that one statement, exactly as it does to separate queries.
export const requestRelations = relations(request, ({ one, many }) => ({
  department: one(department, { fields: [request.departmentId], references: [department.id] }),
  files: many(requestFile),
  accounting: many(accounting),
  payments: many(payment),
  events: many(event),
  comments: many(comment),
  queries: many(query),
}));

export const requestFileRelations = relations(requestFile, ({ one }) => ({
  request: one(request, { fields: [requestFile.requestId], references: [request.id] }),
}));

export const accountingRelations = relations(accounting, ({ one }) => ({
  request: one(request, { fields: [accounting.requestId], references: [request.id] }),
}));

export const paymentRelations = relations(payment, ({ one }) => ({
  request: one(request, { fields: [payment.requestId], references: [request.id] }),
}));

export const eventRelations = relations(event, ({ one }) => ({
  request: one(request, { fields: [event.requestId], references: [request.id] }),
  actorUser: one(user, { fields: [event.actor], references: [user.id] }),
}));

export const commentRelations = relations(comment, ({ one }) => ({
  request: one(request, { fields: [comment.requestId], references: [request.id] }),
  authorUser: one(user, { fields: [comment.author], references: [user.id] }),
}));

export const queryRelations = relations(query, ({ one }) => ({
  request: one(request, { fields: [query.requestId], references: [request.id] }),
  raisedByUser: one(user, { fields: [query.raisedBy], references: [user.id], relationName: "query_raised_by" }),
  // The request record shows answered queries too, with the name of whoever
  // answered — so the answer that unfroze a request stays in its history.
  answeredByUser: one(user, { fields: [query.answeredBy], references: [user.id], relationName: "query_answered_by" }),
}));

// Lets the app read a person and their active grants in one statement (see
// src/auth/viewer.ts) instead of two.
export const userRelations = relations(user, ({ many }) => ({
  roleGrants: many(roleGrant),
}));

export const roleGrantRelations = relations(roleGrant, ({ one }) => ({
  user: one(user, { fields: [roleGrant.userId], references: [user.id] }),
}));
