import { CONFIDENCE_FLOORS, isDecisiveField } from "@/extraction/confidenceFloors";

// Which extracted fields the requester must confirm before moving on.
// Decisive fields (amount, vendor, invoice/quotation no.) use the same
// floors that trigger the tier-2 re-run on the server, so "unsure" on
// screen and "unsure" in the escalation rate mean the same thing. The
// other fields only ever get a badge, so they keep the capture screen's
// original 0.8 line.
export type ExtractedField = "vendor" | "amount" | "invoiceNo" | "invoiceDate" | "gstin";
export type FieldConfidence = Partial<Record<ExtractedField, number>>;

const DISPLAY_FLOOR = 0.8;

export function isLowConfidence(field: ExtractedField, confidence: number | undefined): boolean {
  if (confidence === undefined) return false;
  const floor = isDecisiveField(field) ? CONFIDENCE_FLOORS[field] : DISPLAY_FLOOR;
  return confidence < floor;
}

// The fields the details step shows up front for each kind of request —
// the ones worth holding the requester on. An advance has no bill date
// (the invoice comes later) and GSTIN sits behind "More details", so
// neither is gated; both still get a badge.
export function fieldsToConfirm(kind: "invoice" | "advance"): ExtractedField[] {
  return kind === "advance" ? ["vendor", "invoiceNo", "amount"] : ["vendor", "invoiceNo", "invoiceDate", "amount"];
}

// Low-confidence fields the requester hasn't yet confirmed or edited,
// optionally limited to `only`. Fields the model never read (no
// confidence) aren't included — they're simply blank and typed like any
// form field.
export function unconfirmedFields(confidence: FieldConfidence, confirmed: ReadonlySet<ExtractedField>, only?: ExtractedField[]): ExtractedField[] {
  const candidates = only ?? (Object.keys(confidence) as ExtractedField[]);
  return candidates.filter((f) => isLowConfidence(f, confidence[f]) && !confirmed.has(f));
}
