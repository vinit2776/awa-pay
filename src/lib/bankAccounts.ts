// The documented (not Postgres-enforced) shape of company.bank_accounts —
// an existing jsonb column from phase 1, unused until now. The payer picks
// one entry by id; the whole entry is copied verbatim into
// payment.from_account at pay time (see src/requests/transitions.ts), so a
// later edit here never retroactively changes an immutable payment record.
export type BankAccount = {
  id: string;
  label: string;
  bankName: string;
  accountNumber: string;
  ifsc: string;
};

export function parseBankAccounts(value: unknown): BankAccount[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is BankAccount =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as BankAccount).id === "string" &&
      typeof (entry as BankAccount).label === "string" &&
      typeof (entry as BankAccount).bankName === "string" &&
      typeof (entry as BankAccount).accountNumber === "string" &&
      typeof (entry as BankAccount).ifsc === "string",
  );
}
