import { and, desc, eq } from "drizzle-orm";
import { verifySession } from "@/auth/dal";
import { withGrantScope, UnauthorizedGrantError } from "@/db/runtime";
import { department, event, request, user } from "@/db/schema";
import { actorHoldsRole } from "@/duplicates/duplicateCore";
import { CaptureForm } from "./CaptureForm";

export default async function NewRequestPage({ searchParams }: PageProps<"/requests/new">) {
  const session = await verifySession();
  const { relink } = await searchParams;
  const linkedRequestId = typeof relink === "string" ? relink : null;

  let departments: { id: string; name: string }[];
  try {
    departments = await withGrantScope(session.userId, "requester", (tx) =>
      tx.select({ id: department.id, name: department.name }).from(department).where(eq(department.active, true)),
    );
  } catch (err) {
    if (err instanceof UnauthorizedGrantError) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <h1 className="text-xl font-semibold">Not permitted</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Your account isn&apos;t set up to raise requests.
          </p>
        </div>
      );
    }
    throw err;
  }

  // The reconsideration flow (phase 11): resolved here, server-side, so
  // the banner shows real data rather than trusting the query param's own
  // ref/approver-name — those are only ever derived from the linked
  // request's own visible row and trail. A stale/inaccessible ?relink=
  // value just means no banner shows; the capture flow itself still
  // works normally either way.
  let reconsidering: { ref: string; declinedBy: string | null } | null = null;
  if (linkedRequestId) {
    reconsidering = await withGrantScope(session.userId, "requester", async (tx) => {
      const [original] = await tx.select({ ref: request.ref }).from(request).where(and(eq(request.id, linkedRequestId), eq(request.stage, "rejected"))).limit(1);
      if (!original) return null;
      const [rejectedEvent] = await tx
        .select({ actorName: user.name })
        .from(event)
        .leftJoin(user, eq(user.id, event.actor))
        .where(and(eq(event.requestId, linkedRequestId), eq(event.type, "request.rejected")))
        .orderBy(desc(event.at))
        .limit(1);
      return { ref: original.ref, declinedBy: rejectedEvent?.actorName ?? null };
    }).catch(() => null);
  }

  // Whether an override control should even render — re-checked for real
  // server-side on every submission attempt regardless (captureCore.ts's
  // actorHoldsRole), this is only about not showing a control that would
  // just be refused.
  const canOverride = await actorHoldsRole(session.userId, "super_admin");

  return (
    <div className="flex flex-1 flex-col items-center gap-6 px-4 py-8">
      <h1 className="text-2xl font-semibold">Raise a request</h1>
      {reconsidering && (
        <p className="w-full max-w-sm rounded border border-amber-400 bg-amber-50 px-3 py-2 text-sm dark:border-amber-700 dark:bg-amber-950">
          Reconsidering {reconsidering.ref}
          {reconsidering.declinedBy && <> — declined by {reconsidering.declinedBy}</>}. This will be a new request linked back to it.
        </p>
      )}
      <CaptureForm departments={departments} linkedRequestId={linkedRequestId} canOverrideDuplicate={canOverride} />
    </div>
  );
}
