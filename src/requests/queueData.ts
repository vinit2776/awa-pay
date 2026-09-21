import "server-only";
import { and, inArray } from "drizzle-orm";
import type { ScopedTx } from "@/db/runtime";
import { event } from "@/db/schema";
import { STAGE_MOVING_EVENTS, stageEnteredAt } from "./queueRows";

// When each request entered its current stage, batched once per page —
// runs inside the caller's withGrantScope, so it only ever sees events the
// viewer's role can already read.
export async function loadStageEntered(tx: ScopedTx, rows: { id: string; createdAt: Date }[]): Promise<Map<string, Date>> {
  const entered = new Map<string, Date>();
  if (rows.length === 0) return entered;

  const events = await tx
    .select({ requestId: event.requestId, type: event.type, at: event.at })
    .from(event)
    .where(and(inArray(event.requestId, rows.map((r) => r.id)), inArray(event.type, [...STAGE_MOVING_EVENTS])));

  const byRequest = new Map<string, { type: string; at: Date }[]>();
  for (const e of events) {
    if (!e.requestId) continue;
    const list = byRequest.get(e.requestId);
    if (list) list.push(e);
    else byRequest.set(e.requestId, [e]);
  }

  for (const r of rows) entered.set(r.id, stageEnteredAt(byRequest.get(r.id) ?? [], r.createdAt));
  return entered;
}
