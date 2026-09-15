import Link from "next/link";
import { getCurrentUser } from "@/auth/dal";
import { withActorScope } from "@/db/runtime";
import { getActiveRoleGrants } from "@/auth/roles";
import { logout } from "./actions";

export default async function Home() {
  const currentUser = await getCurrentUser();
  const grants = currentUser ? await withActorScope(currentUser.id, (tx) => getActiveRoleGrants(tx, currentUser.id)) : [];
  const roles = new Set(grants.map((g) => g.role));

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-2xl font-semibold">awa-pay</h1>
      {currentUser && <p className="text-zinc-600 dark:text-zinc-400">Signed in as {currentUser.email}</p>}

      <nav className="flex flex-col gap-2 text-sm">
        {roles.has("requester") && (
          <Link href="/requests/new" className="underline">
            Raise a request
          </Link>
        )}
        {roles.has("requester") && (
          <Link href="/requests" className="underline">
            My requests
          </Link>
        )}
        {roles.has("approver") && (
          <Link href="/approvals" className="underline">
            Approvals
          </Link>
        )}
        {roles.has("accountant") && (
          <Link href="/accounts" className="underline">
            To account
          </Link>
        )}
        {roles.has("payer") && (
          <Link href="/payments" className="underline">
            To pay
          </Link>
        )}
      </nav>

      <form action={logout}>
        <button type="submit" className="rounded border border-zinc-300 px-4 py-2 font-medium dark:border-zinc-700">
          Sign out
        </button>
      </form>
    </div>
  );
}
