"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { approveAction, holdAction, rejectAction, releaseHoldAction, returnToRequesterAction } from "./actions";
import type { HoldSubReason, PaymentCycle } from "@/requests/transitions";

const HOLD_SUB_REASONS: { value: HoldSubReason; label: string }[] = [
  { value: "short_supply", label: "Short supply" },
  { value: "damaged", label: "Damaged" },
  { value: "quality_rejected", label: "Quality rejected" },
  { value: "rate_dispute", label: "Rate dispute" },
  { value: "awaiting_credit_note", label: "Awaiting credit note" },
  { value: "service_not_rendered", label: "Service not rendered" },
];

type Mode = "qualify" | "decline";
type DeclineKind = "return" | "hold" | "reject";

export function ApproverPanel({ requestId, stage }: { requestId: string; stage: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("qualify");
  const [declineKind, setDeclineKind] = useState<DeclineKind>("return");
  const [cycle, setCycle] = useState<PaymentCycle>("unspecified");
  const [dueDate, setDueDate] = useState("");
  const [note, setNote] = useState("");
  const [reviewOn, setReviewOn] = useState("");
  const [subReason, setSubReason] = useState<HoldSubReason>("short_supply");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setPending(true);
    setError(null);
    const result = await action();
    setPending(false);
    if (!result.ok) {
      setError(result.error ?? "Something went wrong.");
      return;
    }
    router.refresh();
  }

  if (stage === "on_hold") {
    return (
      <div className="flex flex-col gap-3 rounded border border-zinc-300 p-4 dark:border-zinc-700">
        <h2 className="text-sm font-medium">On hold</h2>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => void run(() => releaseHoldAction(requestId))}
            className="rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
          >
            Release hold
          </button>
          <button
            type="button"
            disabled={pending || !reason.trim()}
            onClick={() => void run(() => rejectAction(requestId, { reason }))}
            className="rounded border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700"
          >
            Reject
          </button>
        </div>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (required to reject)"
          className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded border border-zinc-300 p-4 dark:border-zinc-700">
      <div className="flex gap-2 text-sm">
        <button type="button" onClick={() => setMode("qualify")} className={mode === "qualify" ? "font-semibold underline" : ""}>
          Qualify
        </button>
        <button type="button" onClick={() => setMode("decline")} className={mode === "decline" ? "font-semibold underline" : ""}>
          Decline
        </button>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {mode === "qualify" ? (
        <>
          <fieldset className="flex flex-col gap-1 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" checked={cycle === "unspecified"} onChange={() => setCycle("unspecified")} />
              Unspecified — payer&apos;s discretion
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={cycle === "immediate"} onChange={() => setCycle("immediate")} />
              Immediate
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={cycle === "dated"} onChange={() => setCycle("dated")} />
              On or before
            </label>
            {cycle === "dated" && (
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-black"
              />
            )}
          </fieldset>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note to accounts & payer (optional)"
            rows={2}
            className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
          />
          <button
            type="button"
            disabled={pending || (cycle === "dated" && !dueDate)}
            onClick={() =>
              void run(() =>
                approveAction(requestId, { cycle, dueDate: cycle === "dated" ? dueDate : null, noteToAccountsAndPayer: note || null }),
              )
            }
            className="rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
          >
            Approve
          </button>
        </>
      ) : (
        <>
          <fieldset className="flex flex-col gap-1 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" checked={declineKind === "return"} onChange={() => setDeclineKind("return")} />
              Return for correction
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={declineKind === "hold"} onChange={() => setDeclineKind("hold")} />
              Hold — vendor issue
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={declineKind === "reject"} onChange={() => setDeclineKind("reject")} />
              Reject — will not be paid
            </label>
          </fieldset>

          {declineKind === "hold" && (
            <>
              <select
                value={subReason}
                onChange={(e) => setSubReason(e.target.value as HoldSubReason)}
                className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
              >
                {HOLD_SUB_REASONS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
              <input
                type="date"
                value={reviewOn}
                onChange={(e) => setReviewOn(e.target.value)}
                className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
              />
            </>
          )}

          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason — required, the requester will read it"
            rows={2}
            className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
          />

          <button
            type="button"
            disabled={pending || !reason.trim() || (declineKind === "hold" && !reviewOn)}
            onClick={() => {
              if (declineKind === "return") void run(() => returnToRequesterAction(requestId, { reason }));
              else if (declineKind === "hold") void run(() => holdAction(requestId, { reviewOn, subReason, reason }));
              else void run(() => rejectAction(requestId, { reason }));
            }}
            className="rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
          >
            {declineKind === "return" ? "Return" : declineKind === "hold" ? "Place on hold" : "Reject"}
          </button>
        </>
      )}
    </div>
  );
}
