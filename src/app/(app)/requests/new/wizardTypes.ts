export type Kind = "invoice" | "advance";
export type PayMode = "full" | "part";
export type FinalBillWhen = "2w" | "1m" | "after" | "unsure";

export const TOTAL_STEPS = 5;

// Everything the requester types or picks across the five steps. Amounts are
// kept as typed (possibly with Indian-grouping commas); wizardMoney.ts turns
// them into integer paise and into the plain strings the server action wants.
export type WizardForm = {
  kind: Kind | null;
  // The bill number for an invoice, the quotation number for an advance —
  // one field, because extraction reads one document number off page one.
  docNo: string;
  vendor: string;
  invoiceDate: string;
  // The whole amount at stake: the bill total, or the full quoted price.
  amount: string;
  gstin: string;
  payMode: PayMode;
  payNow: string;
  payNowReason: string;
  finalBillWhen: FinalBillWhen | null;
  departmentId: string;
  note: string;
};

export type PatchForm = (partial: Partial<WizardForm>) => void;

export const FINAL_BILL_OPTIONS: { value: FinalBillWhen; label: string; days: number | null }[] = [
  { value: "2w", label: "In 2 weeks", days: 14 },
  { value: "1m", label: "In 1 month", days: 30 },
  { value: "after", label: "After the work", days: null },
  { value: "unsure", label: "Not sure", days: null },
];
