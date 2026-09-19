// The grant rules in one pure place, imported by both the server core
// (src/admin/roleGrantCore.ts, which enforces them) and the grant form
// (which shows them before anyone submits). One definition means the form
// can't promise something the server then refuses. No server imports, so
// it's safe in a client bundle; tests/grant-rules.test.ts pins ROLES to
// the database enum.

export const ROLES = ["requester", "approver", "accountant", "payer", "super_admin", "developer"] as const;
export type GrantableRole = (typeof ROLES)[number];

export const ROLE_LABEL: Record<GrantableRole, string> = {
  requester: "Requester",
  approver: "Approver",
  accountant: "Accountant",
  payer: "Payer",
  super_admin: "Super admin",
  developer: "Developer",
};

// Roles with no department scoping at all — always global, per AGENTS.md's
// own table ("Super admin: Always global", "Developer: Always global").
export const ALWAYS_GLOBAL_ROLES: ReadonlySet<string> = new Set<GrantableRole>(["super_admin", "developer"]);
// Company scope only means something for the two desks that touch the books.
export const COMPANY_SCOPED_ROLES: ReadonlySet<string> = new Set<GrantableRole>(["accountant", "payer"]);

// Why a scope choice is or isn't offered, in the words the form shows.
export function scopeRules(role: GrantableRole): {
  pickDepartments: boolean;
  allowAllDepartments: boolean;
  allDepartmentsReason: string | null;
  pickCompanies: boolean;
} {
  if (ALWAYS_GLOBAL_ROLES.has(role)) {
    return { pickDepartments: false, allowAllDepartments: true, allDepartmentsReason: null, pickCompanies: false };
  }
  return {
    pickDepartments: true,
    allowAllDepartments: role !== "requester",
    allDepartmentsReason: role === "requester" ? "A requester raises bills for named departments only, never all of them." : null,
    pickCompanies: COMPANY_SCOPED_ROLES.has(role),
  };
}

// Roles held together that a super admin should see called out. Neither
// is blocked — AGENTS.md: "Self-approval is permitted, recorded, and
// reported, never blocked" — the point is that it's visible.
export function dutyOverlaps(roles: ReadonlySet<string>): string[] {
  const notes: string[] = [];
  if (roles.has("requester") && roles.has("approver")) {
    notes.push("Can approve bills they raised themselves. That's allowed, and every such approval is recorded against them.");
  }
  if (roles.has("approver") && roles.has("payer")) {
    notes.push("Can both approve a bill and pay it. That's allowed, but the same person controls both ends of the payment.");
  }
  return notes;
}
