import Link from "next/link";
import { verifySession } from "@/auth/dal";
import { listUsers } from "@/admin/roleGrantCore";

export default async function AdminUsersPage({ searchParams }: PageProps<"/admin">) {
  const session = await verifySession();
  const { q } = await searchParams;
  const term = typeof q === "string" ? q.trim() : "";

  const users = await listUsers(session.userId, term);

  return (
    <div className="flex flex-1 flex-col gap-4 px-4 py-8">
      <h1 className="text-2xl font-semibold">Admin — users</h1>

      <form className="flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={term}
          placeholder="Search by name or email"
          className="flex-1 rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700"
        />
        <button type="submit" className="rounded border border-zinc-300 px-4 py-2 text-sm font-medium dark:border-zinc-700">
          Search
        </button>
      </form>

      {users.length === 0 && <p className="text-zinc-600 dark:text-zinc-400">No users match that search.</p>}

      <ul className="flex flex-col gap-2">
        {users.map((u) => (
          <li key={u.id}>
            <Link
              href={`/admin/users/${u.id}`}
              className="flex items-center justify-between rounded border border-zinc-300 px-4 py-3 dark:border-zinc-700"
            >
              <span>
                <span className="font-medium">{u.name}</span>
                <span className="text-zinc-600 dark:text-zinc-400"> · {u.email}</span>
              </span>
              <span className="text-xs text-zinc-600 dark:text-zinc-400">
                {u.status}
                {!u.mfaEnrolled && " · no MFA"}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
