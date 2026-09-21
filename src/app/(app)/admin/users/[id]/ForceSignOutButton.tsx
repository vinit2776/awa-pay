"use client";

import { useState } from "react";
import { buttonClass } from "@/ui/styles";
import { forceSignOutAction } from "../../actions";

// Distinct from revoking a specific grant, which already takes effect
// immediately on its own (src/admin/roleGrantCore.ts's own comment on
// forceSignOut). This kills every active login session right now —
// the harder lever, for e.g. suspected compromise.
export function ForceSignOutButton({ userId, name }: { userId: string; name: string }) {
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function signOut() {
    if (!confirm(`Sign ${name} out on every device right now? They'll have to sign in again.`)) return;
    setPending(true);
    await forceSignOutAction(userId);
    setPending(false);
    setDone(true);
  }

  return (
    <span className="flex items-center gap-2">
      {done && (
        <span role="status" className="text-xs text-ink-2">
          Signed out everywhere.
        </span>
      )}
      <button type="button" disabled={pending} onClick={() => void signOut()} className={buttonClass("danger", "sm")}>
        {pending ? "Signing out…" : "Sign out everywhere"}
      </button>
    </span>
  );
}
