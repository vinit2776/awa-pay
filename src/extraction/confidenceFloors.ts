// The product decision behind "decisive" (docs/START-HERE-slice-4.md):
// amount, vendor and invoiceNo are the fields duplicate control already
// treats as the load-bearing signal (vendor+invoice+FY), so a confidently
// wrong read on any of them is worse than a missing one — these are the
// only fields that trigger escalation. currency is always "INR" in this
// India-only system and is never asked of the model at all (see
// extractCore.ts). invoiceDate and gstin still get a confidence badge on
// the confirmation screen, they just don't gate the tier-2 re-run.
//
// Starting values only — the escalation rate this phase's own
// extraction_attempt table makes measurable is the actual feedback loop
// for tuning these (AGENTS.md: "if it climbs, something changed... if it
// approaches zero, the confidence floor is set too low").
export const DECISIVE_FIELDS = ["amount", "vendor", "invoiceNo"] as const;
export type DecisiveField = (typeof DECISIVE_FIELDS)[number];

export const CONFIDENCE_FLOORS: Record<DecisiveField, number> = {
  amount: 0.85,
  vendor: 0.8,
  invoiceNo: 0.8,
};

export function isDecisiveField(field: string): field is DecisiveField {
  return (DECISIVE_FIELDS as readonly string[]).includes(field);
}
