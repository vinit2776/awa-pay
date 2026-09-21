import { isNull } from "drizzle-orm";
import Link from "next/link";
import { verifySession } from "@/auth/dal";
import { listUsers } from "@/admin/roleGrantCore";
import { ROLE_LABEL, ROLES, type GrantableRole } from "@/admin/grantRules";
import { withGrantScope } from "@/db/runtime";
import { roleGrant } from "@/db/schema";
import { Pill } from "@/ui/Pill";
import { buttonClass, inputClass } from "@/ui/styles";

export default async function AdminUsersPage({ searchParams }: PageProps<"/admin">) {
  const session = await verifySession();
  const { q } = await searchParams;
  const term = typeof q === "string" ? q.trim() : "";

  const users = await listUsers(session.userId, term);
  // Active roles for everyone listed, in one read under the same
  // super_admin scope listUsers uses — role_grant is fully readable there.
  const activeGrants = await withGrantScope(session.userId, "super_admin", (tx) =>
    tx.select({ userId: roleGrant.userId, role: roleGrant.role }).from(roleGrant).where(isNull(roleGrant.revokedAt)),
  );
  const rolesByUser = new Map<string, Set<GrantableRole>>();
  for (const g of activeGrants) {
    const set = rolesByUser.get(g.userId) ?? new Set<GrantableRole>();
    set.add(g.role);
    rolesByUser.set(g.userId, set);
  }

  const missingMfa = users.filter((u) => !u.mfaEnrolled && rolesByUser.get(u.id)?.has("payer")).length;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 px-4 py-6">
      <div className="flex flex-col gap-0.5">
        <h1 className="text-2xl font-semibold tracking-tight">People &amp; access</h1>
        <p className="text-sm text-ink-2">
          {users.length} {users.length === 1 ? "person" : "people"}
          {missingMfa > 0 && ` · ${missingMfa} payer${missingMfa === 1 ? "" : "s"} without two-factor sign-in`}
        </p>
      </div>

      <form className="flex gap-2" role="search">
        <input type="search" name="q" defaultValue={term} aria-label="Search people" placeholder="Name or email" className={inputClass} />
        <button type="submit" className={buttonClass("secondary", "sm")}>
          Search
        </button>
      </form>

      {users.length === 0 ? (
        <p className="rounded-xl border border-line-soft bg-surface p-6 text-center text-sm text-ink-2">
          {term ? "No one matches that search." : "No people yet."}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5 md:gap-0 md:overflow-hidden md:rounded-xl md:border md:border-line md:bg-surface">
          {users.map((u) => {
            const roles = rolesByUser.get(u.id) ?? new Set<GrantableRole>();
            const payerWithoutMfa = roles.has("payer") && !u.mfaEnrolled;
            return (
              <li key={u.id} className="md:border-b md:border-line-soft md:last:border-b-0">
                <Link
                  href={`/admin/users/${u.id}`}
                  className={`flex flex-col gap-1.5 rounded-xl border bg-surface px-3.5 py-3 transition-colors hover:bg-ground focus-visible:outline-2 focus-visible:outline-accent md:rounded-none md:border-0 ${
                    payerWithoutMfa ? "border-warn-line shadow-[inset_3px_0_0_var(--warn)]" : "border-line-soft"
                  }`}
                >
                  <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="text-sm font-semibold">{u.name}</span>
                    <span className="truncate text-xs text-ink-3">{u.email}</span>
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    {ROLES.filter((r) => roles.has(r)).map((r) => (
                      <Pill key={r} tone="neutral">
                        {ROLE_LABEL[r]}
                      </Pill>
                    ))}
                    {roles.size === 0 && <span className="text-xs text-ink-3">No active roles</span>}
                    {u.status !== "active" && <Pill tone="danger">{u.status === "disabled" ? "Disabled" : u.status}</Pill>}
                    {payerWithoutMfa ? <Pill tone="warn">Payer without two-factor</Pill> : !u.mfaEnrolled && <Pill tone="neutral">No two-factor</Pill>}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs text-ink-3">New people can&apos;t be added from here yet — accounts are created by the seed script until an invite flow exists.</p>
    </div>
  );
}
