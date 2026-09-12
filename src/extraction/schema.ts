// The confirmation screen's own six fields (concept-v2.html §02). currency
// is deliberately absent from this type — it's never asked of the model,
// see extractCore.ts.
export type ExtractedField = "vendor" | "amount" | "invoiceNo" | "invoiceDate" | "gstin";

export type FieldReading = { value: string | number | null; confidence: number };

export type ExtractedFields = {
  vendor: FieldReading;
  amount: FieldReading;
  invoiceNo: FieldReading;
  invoiceDate: FieldReading;
  gstin: FieldReading;
};

// Hand-rolled rather than a schema library (this codebase has none — see
// src/lib/bankAccounts.ts's parseBankAccounts for the same convention):
// validates the model's raw tool-call input is shaped the way the rest of
// this module expects, nothing more. Returns null on anything malformed —
// the caller treats that identically to an API error (escalate, then
// degrade to blank fields on a second failure).
export function parseExtractedFields(raw: unknown): ExtractedFields | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  function readingOf(key: string, valueType: "string" | "number"): FieldReading | null {
    const entry = obj[key];
    if (typeof entry !== "object" || entry === null) return null;
    const e = entry as Record<string, unknown>;
    const value = e.value;
    if (value !== null && typeof value !== valueType) return null;
    if (typeof e.confidence !== "number" || e.confidence < 0 || e.confidence > 1) return null;
    return { value: value as string | number | null, confidence: e.confidence };
  }

  const vendor = readingOf("vendor", "string");
  const amount = readingOf("amount", "number");
  const invoiceNo = readingOf("invoiceNo", "string");
  const invoiceDate = readingOf("invoiceDate", "string");
  const gstin = readingOf("gstin", "string");
  if (!vendor || !amount || !invoiceNo || !invoiceDate || !gstin) return null;

  return { vendor, amount, invoiceNo, invoiceDate, gstin };
}
