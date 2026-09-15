"use client";

import { useState } from "react";
import { forceSignOutAction } from "../../actions";

// Distinct from revoking a specific grant, which already takes effect
// immediately on its own (src/admin/roleGrantCore.ts's own comment on
// forceSignOut). This kills every active login session right now —
// the harder lever, for e.g. suspected compromise.
export function ForceSignOutButton({ userId }: { userId: string }) {
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function signOut() {
    if (!confirm("Sign this user out of every active session right now?")) return;
    setPending(true);
    await forceSignOutAction(userId);
    setPending(false);
    setDone(true);
  }

  return (
    <span className="flex items-center gap-2">
      {done && <span className="text-xs text-zinc-600 dark:text-zinc-400">Signed out.</span>}
      <button
        type="button"
        disabled={pending}
        onClick={() => void signOut()}
        className="rounded border border-red-300 px-3 py-1 text-xs font-medium text-red-700 disabled:opacity-50 dark:border-red-900 dark:text-red-400"
      >
        Force sign-out
      </button>
    </span>
  );
}
