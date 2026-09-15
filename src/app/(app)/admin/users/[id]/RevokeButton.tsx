"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { revokeGrantAction } from "../../actions";

export function RevokeButton({ grantId }: { grantId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revoke() {
    if (!confirm("Revoke this role grant?")) return;
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
    <span className="flex items-center gap-2">
      {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
      <button
        type="button"
        disabled={pending}
        onClick={() => void revoke()}
        className="rounded border border-zinc-300 px-3 py-1 text-xs font-medium disabled:opacity-50 dark:border-zinc-700"
      >
        Revoke
      </button>
    </span>
  );
}
