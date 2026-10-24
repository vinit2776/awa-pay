import type { Role } from "@/db/runtime";
import type { requestStageEnum } from "@/db/schema";

type Stage = (typeof requestStageEnum.enumValues)[number];

// "A nudge is aimed at whoever currently owns the stage" (brief §07) — the
// same question every desk's own queue page already answers by filtering
// on stage, just asked for one request instead of a whole pool. A stage
// with no owner (closed, one way or another) has nobody left to nudge.
export const STAGE_OWNER_ROLE: Record<Stage, Role | null> = {
  raised: "requester",
  awaiting_approval: "approver",
  with_accounts: "accountant",
  to_pay: "payer",
  on_hold: "approver",
  paid: null,
  rejected: null,
  // The vendor owes the tax invoice, and the requester is who chases it.
  awaiting_invoice: "requester",
  withdrawn: null,
};
