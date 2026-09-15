import "server-only";
import { and, arrayContains, count, eq, isNull } from "drizzle-orm";
import { cache } from "react";
import { getCurrentUser } from "@/auth/dal";
import { getActiveRoleGrants } from "@/auth/roles";
import { withActorScope, withGrantScope } from "@/db/runtime";
import { query, request } from "@/db/schema";
import type { NavCounts, NavRole } from "./nav";

// One load per request, shared by the (app) layout's shell and the home
// page's tiles. Every count runs through withGrantScope under the role it
// counts for, so a badge can never show more than that queue would.
export const getShellContext = cache(async () => {
  const user = await getCurrentUser();
  if (!user) return null;

  const grants = await withActorScope(user.id, (tx) => getActiveRoleGrants(tx, user.id));
  const roles = new Set<string>(grants.map((g) => g.role));
  const counts = await loadNavCounts(user.id, roles);

  return { user, roles, counts };
});

const QUEUE_STAGE = {
  approver: "awaiting_approval",
  accountant: "with_accounts",
  payer: "to_pay",
} as const;

async function loadNavCounts(userId: string, roles: ReadonlySet<string>): Promise<NavCounts> {
  const jobs: Promise<[NavRole, number]>[] = [];

  if (roles.has("requester")) jobs.push(countNeedsRequester(userId).then((n) => ["requester", n]));

  for (const role of ["approver", "accountant", "payer"] as const) {
    if (!roles.has(role)) continue;
    jobs.push(
      withGrantScope(userId, role, async (tx) => {
        const [row] = await tx.select({ n: count() }).from(request).where(eq(request.stage, QUEUE_STAGE[role]));
        return [role, row?.n ?? 0] as [NavRole, number];
      }),
    );
  }

  // A badge is a convenience; a failed count must not take every page
  // down with it. The failure is logged and the badge simply doesn't show.
  const settled = await Promise.allSettled(jobs);
  const counts: NavCounts = {};
  for (const result of settled) {
    if (result.status === "fulfilled") counts[result.value[0]] = result.value[1];
    else console.error("nav count failed", result.reason);
  }
  return counts;
}

// "Needs you" for a requester: bills returned to them (stage raised) plus
// bills with an open query directed at the requester role.
async function countNeedsRequester(userId: string): Promise<number> {
  return withGrantScope(userId, "requester", async (tx) => {
    const returned = await tx
      .select({ id: request.id })
      .from(request)
      .where(and(eq(request.raisedBy, userId), eq(request.stage, "raised")));
    const queried = await tx
      .selectDistinct({ id: query.requestId })
      .from(query)
      .innerJoin(request, eq(request.id, query.requestId))
      .where(and(eq(request.raisedBy, userId), isNull(query.resolvedAt), arrayContains(query.directedAt, ["requester"])));
    return new Set([...returned.map((r) => r.id), ...queried.map((q) => q.id)]).size;
  });
}
