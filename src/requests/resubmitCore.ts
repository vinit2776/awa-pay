import { eq } from "drizzle-orm";
import { withGrantScope } from "@/db/runtime";
import { request } from "@/db/schema";
import { resubmitRequest, type ResubmitAttachment } from "./transitions";

// Pure orchestration, no next/headers — mirrors captureCore.ts. Validates
// ownership and stage before handing off to transitions.ts's
// resubmitRequest, which is the actual RLS/stage gate.

export type ResubmitParams = {
  userId: string;
  requestId: string;
  ip: string;
  userAgent: string | undefined;
  amountMinor: number;
  invoiceNo?: string;
  invoiceDate?: string;
  vendor?: string;
  note?: string;
  newAttachments: ResubmitAttachment[];
};

export type ResubmitResult = { ok: true } | { ok: false; error: string };

export async function resubmit(params: ResubmitParams): Promise<ResubmitResult> {
  // request_select's requester branch is department-scoped, not "mine
  // only" — within a department's pool any requester can see any request
  // raised there (phase 1's design: "nothing is individually assigned").
  // The raisedBy check below is what actually restricts resubmit to the
  // person who raised it, matching the brief's "Returned to you" screen.
  const [req] = await withGrantScope(params.userId, "requester", (tx) =>
    tx.select().from(request).where(eq(request.id, params.requestId)),
  );

  if (!req) {
    return { ok: false, error: "Request not found." };
  }
  if (req.raisedBy !== params.userId) {
    return { ok: false, error: "Only the requester who raised this can resubmit it." };
  }
  // stage === 'raised' already fully means "returned for correction" —
  // captureCore.ts always inserts as 'awaiting_approval', so nothing else
  // sets a request back to 'raised'. A revision > 1 condition here used to
  // additionally require a request had already been resubmitted once
  // before, which rejected every legitimate first-time resubmit outright.
  if (req.stage !== "raised") {
    return { ok: false, error: "This request isn't waiting on a resubmission." };
  }

  // request_pay_now_within_total_check would otherwise turn this into a bare
  // database error: what was asked for now can't exceed the new total.
  if (req.payNowMinor !== null && params.amountMinor < req.payNowMinor) {
    return { ok: false, error: "The total can't be less than the amount already asked for now. Raise a new request instead." };
  }

  return resubmitRequest(
    params.userId,
    params.requestId,
    {
      amountMinor: params.amountMinor,
      invoiceNo: params.invoiceNo,
      invoiceDate: params.invoiceDate,
      vendor: params.vendor,
      note: params.note,
      newAttachments: params.newAttachments,
    },
    { ip: params.ip, userAgent: params.userAgent },
  );
}
