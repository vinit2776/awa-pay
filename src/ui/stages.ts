// Display rules for a request's stage — pure, no schema import, so client
// components can use it without pulling drizzle into the browser bundle.
// tests/ui.test.ts pins STAGES to requestStageEnum so the two can't drift.

export const STAGES = ["raised", "awaiting_approval", "with_accounts", "to_pay", "paid", "on_hold", "rejected", "withdrawn"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABEL: Record<Stage, string> = {
  raised: "Raised",
  awaiting_approval: "Awaiting approval",
  with_accounts: "With accounts",
  to_pay: "To pay",
  paid: "Paid",
  on_hold: "On hold",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

export type Tone = "neutral" | "info" | "ok" | "warn" | "danger";

export const STAGE_TONE: Record<Stage, Tone> = {
  raised: "neutral",
  awaiting_approval: "info",
  with_accounts: "info",
  to_pay: "info",
  paid: "ok",
  on_hold: "warn",
  rejected: "danger",
  withdrawn: "neutral",
};

// The five lifecycle stages a request moves along (AGENTS.md "The
// lifecycle"). The three off-track stages sit on the step where they
// happen: hold and reject are approver answers, withdraw is the
// requester's while the bill is still with them.
const TRACK: { stage: Stage; label: string }[] = [
  { stage: "raised", label: "Raised" },
  { stage: "awaiting_approval", label: "Awaiting approval" },
  { stage: "with_accounts", label: "With accounts" },
  { stage: "to_pay", label: "To pay" },
  { stage: "paid", label: "Paid" },
];

const OFF_TRACK: Partial<Record<Stage, { at: Stage; state: StepState }>> = {
  on_hold: { at: "awaiting_approval", state: "paused" },
  rejected: { at: "awaiting_approval", state: "stopped" },
  withdrawn: { at: "raised", state: "stopped" },
};

export type StepState = "done" | "current" | "paused" | "stopped" | "todo";
export type TrackStep = { stage: Stage; label: string; state: StepState };

// `frozen` is an open query: the request stays where it is, but nothing
// moves until it's answered, so the current step reads as paused.
export function stageTrack(stage: Stage, opts: { frozen?: boolean } = {}): TrackStep[] {
  const off = OFF_TRACK[stage];
  const at = off ? off.at : stage;
  const index = TRACK.findIndex((s) => s.stage === at);

  return TRACK.map((step, i) => {
    if (i < index) return { ...step, state: "done" };
    if (i > index) return { ...step, state: "todo" };
    if (off) return { ...step, label: STAGE_LABEL[stage], state: off.state };
    if (stage === "paid") return { ...step, state: "done" };
    return { ...step, state: opts.frozen ? "paused" : "current" };
  });
}
