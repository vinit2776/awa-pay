import { eq, inArray } from "drizzle-orm";
import { type Role, withGrantScope } from "@/db/runtime";
import { query, user } from "@/db/schema";
import { appendEvent, type Meta } from "@/events/append";
import { lockRequestMutex } from "@/requests/lock";
import { resolveViewerRole } from "@/requests/viewerRole";
import { queryTargetsFor } from "./queryTargets";
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

// directedAt / directedUserIds echo what was actually stored (deduplicated,
// validated), which is what the notification fan-out should be driven by —
// not the raw client input.
export type QueryResult =
  | { ok: true; queryId: string; role: Role; directedAt: Role[]; directedUserIds: string[] }
  | { ok: false; error: string };
export type AnswerResult = { ok: true; role: Role; raisedBy: string } | { ok: false; error: string };

// A query is aimed at roles (anyone holding one, in scope, may answer),
// at named people, or both. Named ids come from the client and are only
// ever treated as claims: raiseQuery resolves them server-side.
export type RaiseQueryParams = { directedAt: Role[]; directedUserIds?: string[]; question: string };

export async function raiseQuery(actorId: string, requestId: string, params: RaiseQueryParams, meta: Meta): Promise<QueryResult> {
  const question = params.question.trim();
  if (!question) {
    return { ok: false, error: "A question is required." };
  }
  const directedAt = [...new Set(params.directedAt)];
  const directedUserIds = [...new Set(params.directedUserIds ?? [])];
  if (directedAt.length === 0 && directedUserIds.length === 0) {
    return { ok: false, error: "Choose who this is directed at." };
  }
  if (directedAt.some((r) => !CONVERSATION_ROLES.includes(r))) {
    return { ok: false, error: "A query can't be directed at that role." };
  }
  if (directedUserIds.includes(actorId)) {
    return { ok: false, error: "You can't direct a query at yourself." };
  }

  const resolved = await resolveViewerRole(actorId, requestId);
  if (!resolved) {
    return { ok: false, error: "Request not found." };
  }
  const { role, request: req } = resolved;
  if (!CONVERSATION_ROLES.includes(role)) {
    return { ok: false, error: "This role can't raise queries." };
  }

  return withGrantScope(actorId, role, async (tx) => {
    await lockRequestMutex(tx, requestId);

    // Each named person must hold an active grant with scope over this
    // request. Checked here, in the same transaction as the insert, so the
    // list can't go stale between validation and write; the RLS on answer
    // re-checks scope live anyway.
    let directedUsers: { id: string; name: string }[] = [];
    if (directedUserIds.length > 0) {
      const eligible = await queryTargetsFor(tx, req);
      if (directedUserIds.some((id) => !eligible.has(id))) {
        return { ok: false, error: "You can only direct a query at people who work on this request." };
      }
      directedUsers = await tx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, directedUserIds));
    }

    const [inserted] = await tx
      .insert(query)
      .values({ requestId, raisedBy: actorId, raisedAsRole: role, directedAt, directedUserIds, question })
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
        // Names are snapshotted alongside the ids so the trail still reads
        // right if a person is later renamed or removed.
        after: { directedAt, directedUserIds, directedUsers, question },
        reason: null,
      },
      meta,
    );

    return { ok: true, queryId: inserted.id, role, directedAt, directedUserIds };
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
    // Same test as query_update's RLS, so the message is the friendly
    // version of what the policy would otherwise refuse: named, or holding
    // a role it was aimed at.
    if (!q.directedAt.includes(role) && !q.directedUserIds.includes(actorId)) {
      return { ok: false, error: "This query isn't directed at you or your role." };
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
