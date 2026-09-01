"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { withdrawAction } from "./actions";

export function WithdrawButton({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function withdraw() {
    if (!confirm("Withdraw this request? This closes it for good — a new request would be needed if circumstances change.")) {
      return;
    }
    setPending(true);
    setError(null);
    const result = await withdrawAction(requestId);
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-1">
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      <button
        type="button"
        disabled={pending}
        onClick={() => void withdraw()}
        className="rounded border border-red-400 px-4 py-2 text-center text-sm font-medium text-red-600 disabled:opacity-50 dark:border-red-800 dark:text-red-400"
      >
        {pending ? "Withdrawing…" : "Withdraw"}
      </button>
    </div>
  );
}
