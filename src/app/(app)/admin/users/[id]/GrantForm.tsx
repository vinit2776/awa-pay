"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { grantRoleAction } from "../../actions";

type Role = "requester" | "approver" | "accountant" | "payer" | "super_admin" | "developer";
type Option = { id: string; name: string };

const ALWAYS_GLOBAL_ROLES = new Set<Role>(["super_admin", "developer"]);
const COMPANY_SCOPED_ROLES = new Set<Role>(["accountant", "payer"]);

export function GrantForm({
  userId,
  roles,
  departments,
  companies,
}: {
  userId: string;
  roles: readonly string[];
  departments: Option[];
  companies: Option[];
}) {
  const router = useRouter();
  const [role, setRole] = useState<Role>("requester");
  const [deptScope, setDeptScope] = useState<"global" | "list">("list");
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const [companyScope, setCompanyScope] = useState<"global" | "list">("global");
  const [companyIds, setCompanyIds] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showScopePicker = !ALWAYS_GLOBAL_ROLES.has(role);
  const showCompanyPicker = COMPANY_SCOPED_ROLES.has(role);
  const globalDisabled = role === "requester";

  function toggle(list: string[], id: string, set: (v: string[]) => void) {
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  }

  async function submit() {
    setPending(true);
    setError(null);
    const result = await grantRoleAction({
      userId,
      role,
      deptScope: showScopePicker ? deptScope : "global",
      departmentIds: showScopePicker && deptScope === "list" ? departmentIds : [],
      companyScope: showCompanyPicker ? companyScope : "n/a",
      companyIds: showCompanyPicker && companyScope === "list" ? companyIds : [],
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

  const canSubmit = !pending && (!showScopePicker || deptScope !== "list" || departmentIds.length > 0) && (!showCompanyPicker || companyScope !== "list" || companyIds.length > 0);

  return (
    <div className="flex flex-col gap-3 rounded border border-dashed border-zinc-300 p-3 dark:border-zinc-700">
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <label className="flex flex-col gap-1 text-sm">
        Role
        <select
          value={role}
          onChange={(e) => {
            setRole(e.target.value as Role);
            setDeptScope("list");
            setDepartmentIds([]);
            setCompanyScope("global");
            setCompanyIds([]);
          }}
          className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-black"
        >
          {roles.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>

      {showScopePicker && (
        <fieldset className="flex flex-col gap-1 text-sm">
          <legend>Department scope</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={deptScope === "global"}
              disabled={globalDisabled}
              onChange={() => setDeptScope("global")}
            />
            Global (every department){globalDisabled && " — not allowed for requester"}
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={deptScope === "list"} onChange={() => setDeptScope("list")} />
            Named departments
          </label>
          {deptScope === "list" && (
            <div className="ml-4 flex max-h-40 flex-col gap-1 overflow-y-auto rounded border border-zinc-200 p-2 dark:border-zinc-800">
              {departments.map((d) => (
                <label key={d.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={departmentIds.includes(d.id)}
                    onChange={() => toggle(departmentIds, d.id, setDepartmentIds)}
                  />
                  {d.name}
                </label>
              ))}
            </div>
          )}
        </fieldset>
      )}

      {showCompanyPicker && (
        <fieldset className="flex flex-col gap-1 text-sm">
          <legend>Company scope</legend>
          <label className="flex items-center gap-2">
            <input type="radio" checked={companyScope === "global"} onChange={() => setCompanyScope("global")} />
            Global (every company)
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={companyScope === "list"} onChange={() => setCompanyScope("list")} />
            Named companies
          </label>
          {companyScope === "list" && (
            <div className="ml-4 flex max-h-40 flex-col gap-1 overflow-y-auto rounded border border-zinc-200 p-2 dark:border-zinc-800">
              {companies.map((c) => (
                <label key={c.id} className="flex items-center gap-2">
                  <input type="checkbox" checked={companyIds.includes(c.id)} onChange={() => toggle(companyIds, c.id, setCompanyIds)} />
                  {c.name}
                </label>
              ))}
            </div>
          )}
        </fieldset>
      )}

      <button
        type="button"
        disabled={!canSubmit}
        onClick={() => void submit()}
        className="self-start rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
      >
        Grant role
      </button>
    </div>
  );
}
