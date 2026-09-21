"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { revokeGrantAction } from "../../actions";

// A revoked grant stops working on the person's very next action —
// assertActiveGrant re-checks on every scoped call — so no sign-out is
// needed for it to take effect.
export function RevokeButton({ grantId, label }: { grantId: string; label: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revoke() {
    if (!confirm(`Revoke ${label}? It stops working on their next action.`)) return;
    setPending(true);
    setError(null);
    const result = await revokeGrantAction(grantId);
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => void revoke()}
        className="rounded-md px-2 py-1 text-xs font-medium text-danger hover:bg-danger-soft focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-45"
      >
        {pending ? "Revoking…" : "Revoke"}
      </button>
      {error && (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      )}
    </span>
  );
}
