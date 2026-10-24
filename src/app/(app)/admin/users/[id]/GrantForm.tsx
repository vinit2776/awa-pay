"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ROLE_LABEL, ROLES, scopeRules, type GrantableRole } from "@/admin/grantRules";
import { Notice } from "@/ui/Notice";
import { buttonClass, inputClass, labelClass } from "@/ui/styles";
import { grantRoleAction } from "../../actions";

type Option = { id: string; name: string };

function Choice({ checked, disabled, onChange, label, reason }: { checked: boolean; disabled?: boolean; onChange: () => void; label: string; reason?: string | null }) {
  return (
    <label className={`flex items-start gap-2 text-[13px] ${disabled ? "text-ink-3" : ""}`}>
      <input type="radio" checked={checked} disabled={disabled} onChange={onChange} className="mt-0.5" />
      <span className="flex flex-col">
        {label}
        {reason && <span className="text-xs text-ink-3">{reason}</span>}
      </span>
    </label>
  );
}

function Checklist({ options, selected, onToggle, label }: { options: Option[]; selected: string[]; onToggle: (id: string) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="ml-6 flex max-h-44 flex-col gap-1 overflow-y-auto rounded-lg border border-line-soft bg-ground p-2">
      {options.length === 0 && <span className="text-xs text-ink-3">None are active yet.</span>}
      {options.map((o) => (
        <label key={o.id} className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={selected.includes(o.id)} onChange={() => onToggle(o.id)} />
          {o.name}
        </label>
      ))}
    </div>
  );
}

// The rules come from src/admin/grantRules.ts — the same module the server
// enforces with — so every option this form offers is one grantRole accepts.
export function GrantForm({
  userId,
  heldRoles,
  mfaEnrolled,
  departments,
  companies,
}: {
  userId: string;
  heldRoles: string[];
  mfaEnrolled: boolean;
  departments: Option[];
  companies: Option[];
}) {
  const router = useRouter();
  const [role, setRole] = useState<GrantableRole>("requester");
  const [deptScope, setDeptScope] = useState<"global" | "list">("list");
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const [companyScope, setCompanyScope] = useState<"global" | "list">("global");
  const [companyIds, setCompanyIds] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rules = scopeRules(role);
  const alreadyHeld = heldRoles.includes(role);

  function toggle(list: string[], id: string, set: (v: string[]) => void) {
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  }

  async function submit() {
    setPending(true);
    setError(null);
    const result = await grantRoleAction({
      userId,
      role,
      deptScope: rules.pickDepartments ? deptScope : "global",
      departmentIds: rules.pickDepartments && deptScope === "list" ? departmentIds : [],
      companyScope: rules.pickCompanies ? companyScope : "n/a",
      companyIds: rules.pickCompanies && companyScope === "list" ? companyIds : [],
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setDepartmentIds([]);
    setCompanyIds([]);
    router.refresh();
  }

  const canSubmit =
    !pending &&
    (!rules.pickDepartments || deptScope !== "list" || departmentIds.length > 0) &&
    (!rules.pickCompanies || companyScope !== "list" || companyIds.length > 0);

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-1">
        <label htmlFor="grant-role" className={labelClass}>
          Role
        </label>
        <select
          id="grant-role"
          value={role}
          onChange={(e) => {
            setRole(e.target.value as GrantableRole);
            setDeptScope("list");
            setDepartmentIds([]);
            setCompanyScope("global");
            setCompanyIds([]);
          }}
          className={`${inputClass} sm:max-w-xs`}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
              {heldRoles.includes(r) ? " (already held)" : ""}
            </option>
          ))}
        </select>
        {alreadyHeld && <span className="text-xs text-ink-3">Granting it again adds a second row — useful for a different set of departments.</span>}
      </div>

      {!rules.pickDepartments && (
        <p className="text-[13px] text-ink-2">
          {ROLE_LABEL[role]} is always global — it covers every department, and has no company scope.
        </p>
      )}

      {rules.pickDepartments && (
        <fieldset className="flex flex-col gap-1.5">
          <legend className={`${labelClass} mb-1`}>Departments</legend>
          <Choice
            checked={deptScope === "global"}
            disabled={!rules.allowAllDepartments}
            onChange={() => setDeptScope("global")}
            label="All departments"
            reason={rules.allDepartmentsReason}
          />
          <Choice checked={deptScope === "list"} onChange={() => setDeptScope("list")} label="Only these departments" />
          {deptScope === "list" && (
            <Checklist options={departments} selected={departmentIds} onToggle={(id) => toggle(departmentIds, id, setDepartmentIds)} label="Departments" />
          )}
        </fieldset>
      )}

      {rules.pickCompanies && (
        <fieldset className="flex flex-col gap-1.5">
          <legend className={`${labelClass} mb-1`}>Companies</legend>
          <p className="text-xs text-ink-3">
            {role === "payer"
              ? "A payer only sees bills already booked to these companies."
              : "An accountant can only book bills to these companies."}
          </p>
          <Choice checked={companyScope === "global"} onChange={() => setCompanyScope("global")} label="All companies" />
          <Choice checked={companyScope === "list"} onChange={() => setCompanyScope("list")} label="Only these companies" />
          {companyScope === "list" && <Checklist options={companies} selected={companyIds} onToggle={(id) => toggle(companyIds, id, setCompanyIds)} label="Companies" />}
        </fieldset>
      )}

      {role === "payer" && !mfaEnrolled && (
        <Notice tone="warn" title="Two-factor sign-in is required for payers">
          This person hasn&apos;t set it up yet.
        </Notice>
      )}

      <button type="button" disabled={!canSubmit} onClick={() => void submit()} className={`${buttonClass("primary", "sm")} self-start`}>
        {pending ? "Granting…" : `Grant ${ROLE_LABEL[role]}`}
      </button>
    </div>
  );
}
