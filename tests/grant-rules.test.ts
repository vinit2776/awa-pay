import { describe, expect, it } from "vitest";
import { dutyOverlaps, ROLES, scopeRules } from "@/admin/grantRules";
import { roleEnum } from "@/db/schema/enums";

// Pure — no database. grantRole's enforcement of these rules is covered
// against the real database in tests/admin.test.ts.

describe("grant rules", () => {
  it("covers exactly the roles the database knows", () => {
    expect([...ROLES].sort()).toEqual([...roleEnum.enumValues].sort());
  });

  it("never offers a requester every department, and says why", () => {
    const rules = scopeRules("requester");
    expect(rules.allowAllDepartments).toBe(false);
    expect(rules.allDepartmentsReason).toMatch(/named departments/);
    expect(rules.pickCompanies).toBe(false);
  });

  it("asks for companies only at the two desks that touch the books", () => {
    expect(scopeRules("accountant").pickCompanies).toBe(true);
    expect(scopeRules("payer").pickCompanies).toBe(true);
    expect(scopeRules("approver").pickCompanies).toBe(false);
  });

  it("asks nothing about scope for always-global roles", () => {
    for (const role of ["super_admin", "developer"] as const) {
      expect(scopeRules(role)).toMatchObject({ pickDepartments: false, pickCompanies: false });
    }
  });
});

describe("duty overlaps", () => {
  it("calls out self-approval and approve-then-pay, and nothing else", () => {
    expect(dutyOverlaps(new Set(["requester", "approver"]))).toHaveLength(1);
    expect(dutyOverlaps(new Set(["approver", "payer"]))).toHaveLength(1);
    expect(dutyOverlaps(new Set(["requester", "approver", "payer"]))).toHaveLength(2);
    expect(dutyOverlaps(new Set(["requester", "payer", "accountant"]))).toEqual([]);
  });
});
