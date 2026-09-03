import { and, eq, sql } from "drizzle-orm";
import { type Role, withGrantScope } from "@/db/runtime";
import { nudge } from "@/db/schema";
import { appendEvent, type Meta } from "@/events/append";
import { lockRequestMutex } from "@/requests/lock";
import { STAGE_OWNER_ROLE } from "@/requests/stageOwner";
import { resolveViewerRole } from "@/requests/viewerRole";
import { CONVERSATION_ROLES } from "./roles";

// Pure orchestration, no next/headers — mirrors queriesCore.ts's shape.
// Doesn't go through runTransition: a nudge never changes request.stage,
// so there's no fromStages/toStage to validate. Takes lockRequestMutex
// first anyway, as the same mutex against runTransition's own lock this
// slice uses throughout — see src/requests/lock.ts for why that isn't a
// plain SELECT request ... FOR UPDATE.

export type NudgeResult = { ok: true; role: Role; toRole: Role } | { ok: false; error: string };

// Postgres error code for a unique-constraint violation. The friendly
// pre-check below (SELECT before INSERT) is UX only — this is what
// actually enforces "once per person per request per IST day"
// (nudge_one_per_person_per_request_per_day_idx, drizzle/migrations/
// 0012_nudges_schema.sql), per AGENTS.md rule 7's own precedent for
// duplicate-bill prevention: the database is the guarantee, not a
// lookup a race can slip past.
const UNIQUE_VIOLATION = "23505";

// drizzle-orm's postgres-js driver wraps the raw postgres.js error (which
// carries `.code` directly) in its own error class whose own top-level
// properties are just { query, params, cause } — the code we actually
// need to check lives one level down, at `err.cause.code`.
function isUniqueViolation(err: unknown): boolean {
  const cause = err && typeof err === "object" && "cause" in err ? (err as { cause?: unknown }).cause : null;
  return Boolean(cause && typeof cause === "object" && "code" in cause && (cause as { code?: unknown }).code === UNIQUE_VIOLATION);
}

export async function sendNudge(actorId: string, requestId: string, meta: Meta): Promise<NudgeResult> {
  const resolved = await resolveViewerRole(actorId, requestId);
  if (!resolved) {
    return { ok: false, error: "Request not found." };
  }
  const { role, request: req } = resolved;
  if (!CONVERSATION_ROLES.includes(role)) {
    return { ok: false, error: "This role can't send nudges." };
  }

  const toRole = STAGE_OWNER_ROLE[req.stage];
  if (!toRole) {
    return { ok: false, error: "Nothing is waiting on this request." };
  }

  return withGrantScope(actorId, role, async (tx) => {
    await lockRequestMutex(tx, requestId);

    const [already] = await tx
      .select({ id: nudge.id })
      .from(nudge)
      .where(
        and(
          eq(nudge.fromUser, actorId),
          eq(nudge.requestId, requestId),
          sql`(${nudge.at} AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date`,
        ),
      )
      .limit(1);
    if (already) {
      return { ok: false, error: "You already nudged today." };
    }

    let inserted: { id: string };
    try {
      [inserted] = await tx.insert(nudge).values({ requestId, fromUser: actorId, fromRole: role, toRole }).returning({ id: nudge.id });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return { ok: false, error: "You already nudged today." };
      }
      throw err;
    }

    await appendEvent(
      tx,
      {
        requestId,
        actor: actorId,
        roleAtTime: role,
        type: "request.nudged",
        objectType: "nudge",
        objectId: inserted.id,
        before: {},
        after: { toRole },
        reason: null,
      },
      meta,
    );

    return { ok: true, role, toRole };
  });
}
