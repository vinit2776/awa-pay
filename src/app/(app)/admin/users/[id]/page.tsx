import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { verifySession } from "@/auth/dal";
import { getUserWithGrants } from "@/admin/roleGrantCore";
import { withGrantScope } from "@/db/runtime";
import { company, department, roleEnum } from "@/db/schema";
import { GrantForm } from "./GrantForm";
import { RevokeButton } from "./RevokeButton";
import { ForceSignOutButton } from "./ForceSignOutButton";

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

  const activeGrants = grants.filter((g) => !g.revokedAt);
  const revokedGrants = grants.filter((g) => g.revokedAt);

  function scopeSummary(g: (typeof grants)[number]): string {
    const dept = g.deptScope === "global" ? "all departments" : (g.departmentIds ?? []).map((id) => deptNameById.get(id) ?? id).join(", ");
    if (g.companyScope === "n/a") return dept;
    const co = g.companyScope === "global" ? "all companies" : (g.companyIds ?? []).map((id) => companyNameById.get(id) ?? id).join(", ");
    return `${dept} · ${co}`;
  }

  return (
    <div className="flex flex-1 flex-col gap-6 px-4 py-8">
      <div>
        <h1 className="text-2xl font-semibold">{user.name}</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {user.email} · {user.status}
          {!user.mfaEnrolled && " · no MFA"}
        </p>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Active grants</h2>
        {activeGrants.length === 0 && <p className="text-sm text-zinc-600 dark:text-zinc-400">No active roles.</p>}
        <ul className="flex flex-col gap-2">
          {activeGrants.map((g) => (
            <li key={g.id} className="flex items-center justify-between rounded border border-zinc-300 px-4 py-3 dark:border-zinc-700">
              <span>
                <span className="font-medium">{g.role}</span>
                <span className="text-zinc-600 dark:text-zinc-400"> · {scopeSummary(g)}</span>
              </span>
              <RevokeButton grantId={g.id} />
            </li>
          ))}
        </ul>
        <div>
          <ForceSignOutButton userId={user.id} />
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Grant a role</h2>
        <GrantForm userId={user.id} roles={roleEnum.enumValues} departments={departments} companies={companies} />
      </section>

      {revokedGrants.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="font-medium">Revoked grants</h2>
          <ul className="flex flex-col gap-2">
            {revokedGrants.map((g) => (
              <li key={g.id} className="rounded border border-zinc-200 px-4 py-3 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-500">
                {g.role} · {scopeSummary(g)} · revoked {g.revokedAt?.toLocaleString()}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
