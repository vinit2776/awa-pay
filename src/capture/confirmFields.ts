import { CONFIDENCE_FLOORS, isDecisiveField } from "@/extraction/confidenceFloors";

// Which extracted fields the requester must confirm before sending.
// Decisive fields (amount, vendor, invoice no.) use the same floors that
// trigger the tier-2 re-run on the server, so "unsure" on screen and
// "unsure" in the escalation rate mean the same thing. The other fields
// only ever get a badge, never a gate, so they keep the capture screen's
// original 0.8 line.
export type ExtractedField = "vendor" | "amount" | "invoiceNo" | "invoiceDate" | "gstin";
export type FieldConfidence = Partial<Record<ExtractedField, number>>;

const DISPLAY_FLOOR = 0.8;

export function isLowConfidence(field: ExtractedField, confidence: number | undefined): boolean {
  if (confidence === undefined) return false;
  const floor = isDecisiveField(field) ? CONFIDENCE_FLOORS[field] : DISPLAY_FLOOR;
  return confidence < floor;
}

// Low-confidence fields the requester hasn't yet confirmed or edited.
// Fields the model never read (no confidence) aren't included — they're
// simply blank, and the requester types them like any form.
export function unconfirmedFields(confidence: FieldConfidence, confirmed: ReadonlySet<ExtractedField>): ExtractedField[] {
  return (Object.keys(confidence) as ExtractedField[]).filter((f) => isLowConfidence(f, confidence[f]) && !confirmed.has(f));
}
