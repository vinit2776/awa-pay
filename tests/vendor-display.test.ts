import { describe, expect, it } from "vitest";
import { bankVersions, indianFinancialYear, paidInFinancialYear, type BankRowForHistory } from "@/vendors/vendorDisplay";

// Pure — no database.

const bank = (id: string, supersededAt: string | null, enteredByName: string): BankRowForHistory => ({
  id,
  beneficiaryName: "Shree Ganesh Electricals",
  accountNumberLast4: "7731",
  ifsc: "HDFC0001873",
  branch: null,
  effectiveFrom: "2026-04-01",
  supersededAt: supersededAt ? new Date(supersededAt) : null,
  verifiedAt: null,
  enteredByName,
  enteredAsRole: "accountant",
  verifiedByName: null,
});

describe("bank versions", () => {
  it("numbers versions in the order they were replaced, live one last", () => {
    const versions = bankVersions([bank("live", null, "R. Iyer"), bank("v2", "2026-08-01T00:00:00Z", "A. Joshi"), bank("v1", "2026-05-01T00:00:00Z", "S. Patil")]);
    expect(versions.map((v) => [v.id, v.version, v.current])).toEqual([
      ["v1", 1, false],
      ["v2", 2, false],
      ["live", 3, true],
    ]);
  });

  it("names who entered the replacement for each replaced version", () => {
    const versions = bankVersions([bank("live", null, "R. Iyer"), bank("v1", "2026-08-01T00:00:00Z", "S. Patil")]);
    expect(versions[0].replacedByName).toBe("R. Iyer");
    expect(versions[1].replacedByName).toBeNull();
  });
});

describe("financial year", () => {
  it("runs April to March", () => {
    expect(indianFinancialYear("2026-04-01")).toBe("2026-27");
    expect(indianFinancialYear("2026-09-15")).toBe("2026-27");
    expect(indianFinancialYear("2027-03-31")).toBe("2026-27");
    expect(indianFinancialYear("2026-03-31")).toBe("2025-26");
  });

  it("formats a century rollover", () => {
    expect(indianFinancialYear("2099-06-01")).toBe("2099-00");
  });

  it("totals only the payments in that year", () => {
    const payments = [
      { amountMinor: 1_22_380_00, valueDate: "2026-09-02" },
      { amountMinor: 2_48_900_00, valueDate: "2026-07-11" },
      { amountMinor: 50_000_00, valueDate: "2026-03-20" },
    ];
    expect(paidInFinancialYear(payments, "2026-27")).toEqual({ totalMinor: 3_71_280_00, count: 2 });
  });
});
