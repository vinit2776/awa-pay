import { eq } from "drizzle-orm";
import { type Role, withGrantScope } from "@/db/runtime";
import { query } from "@/db/schema";
import { appendEvent, type Meta } from "@/events/append";
import { lockRequestMutex } from "@/requests/lock";
import { resolveViewerRole } from "@/requests/viewerRole";
import { CONVERSATION_ROLES } from "./roles";

// Pure orchestration, no next/headers — mirrors commentsCore.ts's shape.
// Neither function goes through src/requests/transitions.ts's
// runTransition: raising/answering a query never changes request.stage
// (a query is a freeze, not a transition — see that file's own freeze
// check), so there's no fromStages/toStage to validate against. Both take
// lockRequestMutex first anyway, purely as a mutex against runTransition's
// identical lock on the same row — the lock ordering rule this slice
// follows throughout: request locked before any child row. See
// src/requests/lock.ts for why this isn't a plain
// SELECT request ... FOR UPDATE (it silently locks nothing for a
// requester acting on a non-'raised'-stage request — traced and fixed as
// part of phase 7, a real regression from when this file was written).

export type QueryResult = { ok: true; queryId: string; role: Role } | { ok: false; error: string };
export type AnswerResult = { ok: true; role: Role; raisedBy: string } | { ok: false; error: string };

export type RaiseQueryParams = { directedAt: Role[]; question: string };

export async function raiseQuery(actorId: string, requestId: string, params: RaiseQueryParams, meta: Meta): Promise<QueryResult> {
  const question = params.question.trim();
  if (!question) {
    return { ok: false, error: "A question is required." };
  }
  if (params.directedAt.length === 0) {
    return { ok: false, error: "Choose who this is directed at." };
  }

  const resolved = await resolveViewerRole(actorId, requestId);
  if (!resolved) {
    return { ok: false, error: "Request not found." };
  }
  const { role } = resolved;
  if (!CONVERSATION_ROLES.includes(role)) {
    return { ok: false, error: "This role can't raise queries." };
  }

  return withGrantScope(actorId, role, async (tx) => {
    await lockRequestMutex(tx, requestId);

    const [inserted] = await tx
      .insert(query)
      .values({ requestId, raisedBy: actorId, raisedAsRole: role, directedAt: params.directedAt, question })
      .returning({ id: query.id });

    await appendEvent(
      tx,
      {
        requestId,
        actor: actorId,
        roleAtTime: role,
        type: "request.query_raised",
        objectType: "query",
        objectId: inserted.id,
        before: {},
        after: { directedAt: params.directedAt, question },
        reason: null,
      },
      meta,
    );

    return { ok: true, queryId: inserted.id, role };
  });
}

export type AnswerQueryParams = { answer: string };

export async function answerQuery(
  actorId: string,
  requestId: string,
  queryId: string,
  params: AnswerQueryParams,
  meta: Meta,
): Promise<AnswerResult> {
  const answer = params.answer.trim();
  if (!answer) {
    return { ok: false, error: "An answer is required." };
  }

  const resolved = await resolveViewerRole(actorId, requestId);
  if (!resolved) {
    return { ok: false, error: "Request not found." };
  }
  const { role } = resolved;

  return withGrantScope(actorId, role, async (tx) => {
    await lockRequestMutex(tx, requestId);

    const [q] = await tx.select().from(query).where(eq(query.id, queryId)).for("update");
    if (!q || q.requestId !== requestId) {
      return { ok: false, error: "Query not found." };
    }
    if (q.resolvedAt) {
      return { ok: false, error: "This query has already been answered." };
    }
    if (!q.directedAt.includes(role)) {
      return { ok: false, error: "This query isn't directed at your role." };
    }

    await tx
      .update(query)
      .set({ answeredBy: actorId, answeredAsRole: role, answer, resolvedAt: new Date() })
      .where(eq(query.id, queryId));

    await appendEvent(
      tx,
      {
        requestId,
        actor: actorId,
        roleAtTime: role,
        type: "request.query_answered",
        objectType: "query",
        objectId: queryId,
        before: { question: q.question },
        after: { answer },
        reason: null,
      },
      meta,
    );

    return { ok: true, role, raisedBy: q.raisedBy };
  });
}
