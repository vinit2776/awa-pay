"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { clearPaymentInProgressAction, holdAsPayerAction, markPaymentInProgressAction, releasePayerHoldAction } from "./actions";

const input = "rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black";
const secondary = "rounded border border-zinc-300 px-3 py-2 text-sm disabled:opacity-50 dark:border-zinc-700";

// The payer's working state inside to_pay: a payment started at the bank
// but not yet confirmed, or a request parked for a reason of the payer's
// own. Neither changes the stage.
export function PayerStatePanel({
  requestId,
  state,
  reason,
  reviewOn,
  since,
  byName,
}: {
  requestId: string;
  state: "in_progress" | "on_hold" | null;
  reason: string | null;
  reviewOn: string | null;
  since: string | null;
  byName: string | null;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"idle" | "progress" | "hold">("idle");
  const [note, setNote] = useState("");
  const [holdReason, setHoldReason] = useState("");
  const [review, setReview] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setPending(true);
    setError(null);
    const result = await fn();
    setPending(false);
    if (!result.ok) {
      setError(result.error ?? "That didn't work.");
      return;
    }
    setMode("idle");
    setNote("");
    setHoldReason("");
    setReview("");
    router.refresh();
  }

  const stamp = since ? new Date(since).toLocaleString() : "";

  return (
    <div className="flex flex-col gap-2 rounded border border-zinc-300 p-3 text-sm dark:border-zinc-700">
      {error && <p className="text-red-600 dark:text-red-400">{error}</p>}

      {state === "in_progress" && (
        <>
          <p className="rounded bg-sky-50 px-3 py-2 text-sky-900 dark:bg-sky-950 dark:text-sky-200">
            <strong>Payment in progress</strong> — started by {byName ?? "a payer"} {stamp && `on ${stamp}`}.{reason && ` ${reason.replace(/[.\s]+$/, "")}.`} Record the payment below when the UTR is back.
          </p>
          <button type="button" disabled={pending} onClick={() => void run(() => clearPaymentInProgressAction(requestId))} className={secondary}>
            It didn&apos;t go through — clear the mark
          </button>
        </>
      )}

      {state === "on_hold" && (
        <>
          <p className="rounded bg-amber-50 px-3 py-2 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <strong>On hold with the payer</strong> by {byName ?? "a payer"} {stamp && `on ${stamp}`}. Review on {reviewOn}. Reason: {reason}
          </p>
          <button type="button" disabled={pending} onClick={() => void run(() => releasePayerHoldAction(requestId))} className={secondary}>
            Release the hold
          </button>
        </>
      )}

      {state === null && mode === "idle" && (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setMode("progress")} className={secondary}>
            Mark payment in progress
          </button>
          <button type="button" onClick={() => setMode("hold")} className={secondary}>
            Put on hold
          </button>
        </div>
      )}

      {state === null && mode === "progress" && (
        <>
          <p className="text-zinc-600 dark:text-zinc-400">
            Use this once you have started the payment at the bank and are waiting for the UTR. It tells everyone else this is being handled.
          </p>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional), e.g. bank batch 3 pm" className={input} />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => void run(() => markPaymentInProgressAction(requestId, { note }))}
              className="rounded bg-black px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
            >
              Mark in progress
            </button>
            <button type="button" onClick={() => setMode("idle")} className={secondary}>
              Cancel
            </button>
          </div>
        </>
      )}

      {state === null && mode === "hold" && (
        <>
          <p className="text-zinc-600 dark:text-zinc-400">Park this with the payer, e.g. insufficient funds or the vendor&apos;s account is frozen. It stays in your queue and stops ageing.</p>
          <textarea value={holdReason} onChange={(e) => setHoldReason(e.target.value)} placeholder="Reason" rows={2} className={input} />
          <label className="flex items-center gap-2">
            Review on
            <input type="date" value={review} onChange={(e) => setReview(e.target.value)} className={input} />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending || !holdReason.trim() || !review}
              onClick={() => void run(() => holdAsPayerAction(requestId, { reason: holdReason, reviewOn: review }))}
              className="rounded bg-black px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
            >
              Put on hold
            </button>
            <button type="button" onClick={() => setMode("idle")} className={secondary}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
