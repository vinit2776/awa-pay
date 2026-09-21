import { and, desc, eq } from "drizzle-orm";
import { verifySession } from "@/auth/dal";
import { withGrantScope, UnauthorizedGrantError } from "@/db/runtime";
import { department, event, request, user } from "@/db/schema";
import { actorHoldsRoleInTx } from "@/duplicates/duplicateCore";
import { CaptureWizard } from "./CaptureWizard";
import { Callout } from "./wizardUi";

// A ?relink= value that isn't a UUID can't name a request; treating it as
// absent also means the lookup below can never raise a cast error inside the
// shared transaction.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function NewRequestPage({ searchParams }: PageProps<"/requests/new">) {
  const session = await verifySession();
  const { relink } = await searchParams;
  const linkedRequestId = typeof relink === "string" && UUID.test(relink) ? relink : null;

  // Everything this page reads is requester-scoped, so it is one
  // transaction rather than three (departments, the reconsideration banner,
  // the override check).
  let loaded: {
    departments: { id: string; name: string }[];
    reconsidering: { ref: string; declinedBy: string | null } | null;
    canOverride: boolean;
  };
  try {
    loaded = await withGrantScope(session.userId, "requester", async (tx) => {
      const departments = await tx.select({ id: department.id, name: department.name }).from(department).where(eq(department.active, true));

      // The reconsideration flow (phase 11): resolved here, server-side, so
      // the banner shows real data rather than trusting the query param's
      // own ref/approver-name — those are only ever derived from the linked
      // request's own visible row and trail. A stale/inaccessible ?relink=
      // value just means no banner shows; the capture flow itself still
      // works normally either way.
      let reconsidering: { ref: string; declinedBy: string | null } | null = null;
      if (linkedRequestId) {
        const [original] = await tx.select({ ref: request.ref }).from(request).where(and(eq(request.id, linkedRequestId), eq(request.stage, "rejected"))).limit(1);
        if (original) {
          const [rejectedEvent] = await tx
            .select({ actorName: user.name })
            .from(event)
            .leftJoin(user, eq(user.id, event.actor))
            .where(and(eq(event.requestId, linkedRequestId), eq(event.type, "request.rejected")))
            .orderBy(desc(event.at))
            .limit(1);
          reconsidering = { ref: original.ref, declinedBy: rejectedEvent?.actorName ?? null };
        }
      }

      // Whether an override control should even render — re-checked for
      // real server-side on every submission attempt regardless
      // (captureCore.ts's actorHoldsRoleInTx), this is only about not
      // showing a control that would just be refused.
      const canOverride = await actorHoldsRoleInTx(tx, session.userId, "super_admin");

      return { departments, reconsidering, canOverride };
    });
  } catch (err) {
    if (err instanceof UnauthorizedGrantError) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <h1 className="text-xl font-semibold">Not permitted</h1>
          <p className="text-base text-ink-2">
            Your account isn&apos;t set up to raise requests.
          </p>
        </div>
      );
    }
    throw err;
  }
  const { departments, reconsidering, canOverride } = loaded;

  return (
    <div className="flex flex-1 flex-col items-center gap-6 px-4 py-6">
      <h1 className="w-full max-w-md text-base font-medium text-ink-2">Raise a request</h1>
      {reconsidering && (
        <div className="w-full max-w-md">
          <Callout tone="info" title={`Reconsidering ${reconsidering.ref}`}>
            <p>
              {reconsidering.declinedBy && <>Declined by {reconsidering.declinedBy}. </>}This will be a new request linked back to it, and it
              goes back to the same approver.
            </p>
          </Callout>
        </div>
      )}
      <CaptureWizard departments={departments} linkedRequestId={linkedRequestId} canOverrideDuplicate={canOverride} />
    </div>
  );
}
