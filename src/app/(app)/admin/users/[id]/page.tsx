import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { verifySession } from "@/auth/dal";
import { dutyOverlaps, ROLE_LABEL, ROLES } from "@/admin/grantRules";
import { getUserWithGrants } from "@/admin/roleGrantCore";
import { withGrantScope } from "@/db/runtime";
import { company, department } from "@/db/schema";
import { Notice } from "@/ui/Notice";
import { Pill } from "@/ui/Pill";
import { eyebrowClass } from "@/ui/styles";
import { ForceSignOutButton } from "./ForceSignOutButton";
import { GrantForm } from "./GrantForm";
import { RevokeButton } from "./RevokeButton";

function onDate(d: Date): string {
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
}

export default async function AdminUserDetailPage({ params }: PageProps<"/admin/users/[id]">) {
  const session = await verifySession();
  const { id } = await params;

  const result = await getUserWithGrants(session.userId, id);
  if (!result) notFound();
  const { user, grants } = result;

  const [departments, companies] = await withGrantScope(session.userId, "super_admin", async (tx) => {
    const depts = await tx.select({ id: department.id, name: department.name }).from(department).where(eq(department.active, true));
    const cos = await tx.select({ id: company.id, name: company.name }).from(company).where(eq(company.active, true));
    return [depts, cos] as const;
  });

  const deptNameById = new Map(departments.map((d) => [d.id, d.name]));
  const companyNameById = new Map(companies.map((c) => [c.id, c.name]));
  const names = (ids: string[] | null, byId: Map<string, string>) => (ids ?? []).map((i) => byId.get(i) ?? "Inactive").join(", ");

  const activeGrants = grants.filter((g) => !g.revokedAt);
  const revokedGrants = grants.filter((g) => g.revokedAt).reverse();
  const heldRoles = new Set<string>(activeGrants.map((g) => g.role));
  const overlaps = dutyOverlaps(heldRoles);
  const payerWithoutMfa = heldRoles.has("payer") && !user.mfaEnrolled;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-4 py-6">
      <Link href="/admin" className="self-start text-[13px] text-accent hover:underline">
        ‹ People &amp; access
      </Link>

      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{user.name}</h1>
          <p className="truncate text-sm text-ink-2">{user.email}</p>
          <div className="flex flex-wrap gap-1.5 pt-1">
            {user.status === "active" ? <Pill tone="ok">Active</Pill> : <Pill tone="danger">{user.status === "disabled" ? "Disabled" : user.status}</Pill>}
            {user.mfaEnrolled ? <Pill tone="ok">Two-factor on</Pill> : <Pill tone={payerWithoutMfa ? "warn" : "neutral"}>No two-factor</Pill>}
          </div>
        </div>
        <ForceSignOutButton userId={user.id} name={user.name} />
      </header>

      {payerWithoutMfa && (
        <Notice tone="warn" title="Payer without two-factor sign-in">
          Anyone holding the payer role must use two-factor sign-in. {user.name} hasn&apos;t set it up yet.
        </Notice>
      )}

      {overlaps.length > 0 && (
        <Notice tone="info" title="Roles that overlap">
          <ul className="flex list-disc flex-col gap-1 pl-4">
            {overlaps.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </Notice>
      )}

      <section className="flex flex-col gap-2">
        <h2 className={`${eyebrowClass} px-1`}>Active roles · {activeGrants.length}</h2>
        {activeGrants.length === 0 ? (
          <p className="rounded-xl border border-line-soft bg-surface p-4 text-[13px] text-ink-2">No active roles — {user.name} can sign in but can&apos;t see or do anything.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-line text-left font-cond text-[11px] tracking-[0.07em] text-ink-3 uppercase">
                  <th className="px-3 py-2 font-semibold">Role</th>
                  <th className="px-3 py-2 font-semibold">Departments</th>
                  <th className="px-3 py-2 font-semibold">Companies</th>
                  <th className="px-3 py-2 font-semibold">Since</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {[...activeGrants]
                  .sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role))
                  .map((g) => (
                    <tr key={g.id} className="border-b border-line-soft align-top last:border-b-0">
                      <td className="px-3 py-2.5 font-semibold whitespace-nowrap">{ROLE_LABEL[g.role]}</td>
                      <td className="px-3 py-2.5">{g.deptScope === "global" ? <Pill tone="neutral">All departments</Pill> : names(g.departmentIds, deptNameById)}</td>
                      <td className="px-3 py-2.5">
                        {g.companyScope === "n/a" ? (
                          <span className="text-ink-3">n/a</span>
                        ) : g.companyScope === "global" ? (
                          <Pill tone="neutral">All companies</Pill>
                        ) : (
                          names(g.companyIds, companyNameById)
                        )}
                      </td>
                      <td className="px-3 py-2.5 font-mono whitespace-nowrap">{onDate(g.grantedAt)}</td>
                      <td className="px-3 py-2.5 text-right">
                        <RevokeButton grantId={g.id} label={`${ROLE_LABEL[g.role]} from ${user.name}`} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
        <h2 className={eyebrowClass}>Give {user.name} a role</h2>
        <GrantForm userId={user.id} heldRoles={[...heldRoles]} mfaEnrolled={user.mfaEnrolled} departments={departments} companies={companies} />
      </section>

      {revokedGrants.length > 0 && (
        <details className="text-[13px]">
          <summary className="cursor-pointer px-1 text-accent">
            {revokedGrants.length} revoked role{revokedGrants.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-2 flex flex-col gap-1.5">
            {revokedGrants.map((g) => (
              <li key={g.id} className="rounded-lg bg-sunk px-3 py-2 text-ink-2">
                <span className="font-semibold text-ink">{ROLE_LABEL[g.role]}</span> ·{" "}
                {g.deptScope === "global" ? "all departments" : names(g.departmentIds, deptNameById)} · granted {onDate(g.grantedAt)}, revoked{" "}
                {g.revokedAt ? onDate(g.revokedAt) : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
