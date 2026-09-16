"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { buttonClass } from "@/ui/styles";
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
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <button type="button" disabled={pending} onClick={() => void withdraw()} className={buttonClass("danger", "md")}>
        {pending ? "Withdrawing…" : "Withdraw"}
      </button>
    </div>
  );
}
