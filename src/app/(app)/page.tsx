import { getCurrentUser } from "@/auth/dal";
import { logout } from "./actions";

export default async function Home() {
  const currentUser = await getCurrentUser();

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-2xl font-semibold">awa-pay</h1>
      {currentUser && <p className="text-zinc-600 dark:text-zinc-400">Signed in as {currentUser.email}</p>}
      <form action={logout}>
        <button
          type="submit"
          className="rounded border border-zinc-300 px-4 py-2 font-medium dark:border-zinc-700"
        >
          Sign out
        </button>
      </form>
    </div>
  );
}
