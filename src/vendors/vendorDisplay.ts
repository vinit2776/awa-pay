// Pure display rules for the vendor record — no database, so they're
// testable against fixtures. The page does the scoped reads.

export type BankRowForHistory = {
  id: string;
  beneficiaryName: string;
  accountNumberLast4: string;
  ifsc: string;
  branch: string | null;
  effectiveFrom: string;
  supersededAt: Date | null;
  verifiedAt: Date | null;
  enteredByName: string | null;
  enteredAsRole: string;
  verifiedByName: string | null;
};

export type BankVersion = BankRowForHistory & { version: number; current: boolean; replacedByName: string | null };

// Bank details are versioned, never edited: adding new details supersedes
// the current row (vendorsCore.setVendorBank). Versions are numbered in the
// order they were superseded, with the live row last, and each replaced
// version names who entered the one that replaced it — the person a "bank
// changed" flag traces back to.
export function bankVersions(rows: BankRowForHistory[]): BankVersion[] {
  const ordered = [...rows].sort((a, b) => {
    if (a.supersededAt === null) return 1;
    if (b.supersededAt === null) return -1;
    return a.supersededAt.getTime() - b.supersededAt.getTime();
  });
  return ordered.map((row, i) => ({
    ...row,
    version: i + 1,
    current: row.supersededAt === null,
    replacedByName: row.supersededAt === null ? null : (ordered[i + 1]?.enteredByName ?? null),
  }));
}

// India's financial year runs April to March: 15 Sep 2026 is in 2026-27,
// 15 Feb 2027 still is. Takes a calendar date string, as payment.valueDate
// is stored, so no timezone can shift it across a boundary.
export function indianFinancialYear(isoDate: string): string {
  const [year, month] = isoDate.split("-").map(Number);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export function paidInFinancialYear(payments: { amountMinor: number; valueDate: string }[], fy: string): { totalMinor: number; count: number } {
  let totalMinor = 0;
  let count = 0;
  for (const p of payments) {
    if (indianFinancialYear(p.valueDate) !== fy) continue;
    totalMinor += p.amountMinor;
    count += 1;
  }
  return { totalMinor, count };
}
