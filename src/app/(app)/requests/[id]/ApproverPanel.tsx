"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { buttonClass, inputClass, labelClass } from "@/ui/styles";
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

// The three ways to decline are not the same event, so each says what it
// does rather than hiding behind one word (AGENTS.md's lifecycle).
const DECLINE_KINDS = [
  { value: "return", title: "Return", consequence: "Back to the requester to fix. Comes back as the next revision." },
  { value: "hold", title: "Hold", consequence: "Vendor issue. Parked until a review date, and left out of ageing." },
  { value: "reject", title: "Reject", consequence: "Closed unpaid. Final — only a new request can revisit it." },
] as const;

type DeclineKind = (typeof DECLINE_KINDS)[number]["value"];

export function ApproverPanel({ requestId, stage }: { requestId: string; stage: string }) {
  const router = useRouter();
  const [declining, setDeclining] = useState(false);
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

  const errorLine = error && (
    <p role="alert" className="text-sm text-danger">
      {error}
    </p>
  );

  if (stage === "on_hold") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-ink-2">Parked until the vendor issue is settled. Releasing it puts the bill back in your approval queue.</p>
        {errorLine}
        <button type="button" disabled={pending} onClick={() => void run(() => releaseHoldAction(requestId))} className={buttonClass("primary", "md", true)}>
          Release hold
        </button>
        <div className="flex flex-col gap-2 border-t border-line-soft pt-3">
          <label htmlFor="hold-reject-reason" className={labelClass}>
            Or reject it for good — reason required
          </label>
          <input id="hold-reject-reason" type="text" value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass} />
          <button
            type="button"
            disabled={pending || !reason.trim()}
            onClick={() => void run(() => rejectAction(requestId, { reason }))}
            className={`${buttonClass("danger", "sm")} self-start`}
          >
            Reject
          </button>
        </div>
      </div>
    );
  }

  if (!declining) {
    return (
      <div className="flex flex-col gap-3">
        {errorLine}
        <div className="flex flex-col gap-1.5">
          <span className={labelClass}>When should this be paid?</span>
          <div className="grid grid-cols-3 gap-1 rounded-lg bg-sunk p-1">
            {(
              [
                { value: "unspecified", label: "Payer decides" },
                { value: "immediate", label: "Immediately" },
                { value: "dated", label: "By a date" },
              ] as const
            ).map((c) => (
              <button
                key={c.value}
                type="button"
                aria-pressed={cycle === c.value}
                onClick={() => setCycle(c.value)}
                className={`rounded-md px-2 py-1.5 text-[13px] ${cycle === c.value ? "bg-surface font-semibold text-ink shadow-sm" : "text-ink-2"}`}
              >
                {c.label}
              </button>
            ))}
          </div>
          {cycle === "dated" && (
            <input
              type="date"
              aria-label="Pay on or before"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className={`${inputClass} font-mono`}
            />
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="approve-note" className={labelClass}>
            Note to accounts &amp; payer <span className="font-normal text-ink-3">optional</span>
          </label>
          <textarea id="approve-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} className={inputClass} />
        </div>

        <button
          type="button"
          disabled={pending || (cycle === "dated" && !dueDate)}
          onClick={() =>
            void run(() => approveAction(requestId, { cycle, dueDate: cycle === "dated" ? dueDate : null, noteToAccountsAndPayer: note || null }))
          }
          className={buttonClass("primary", "md", true)}
        >
          Approve · send to accounts
        </button>
        <button type="button" onClick={() => setDeclining(true)} className={`${buttonClass("secondary", "sm")} self-start`}>
          Decline…
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <button type="button" onClick={() => setDeclining(false)} className={`${buttonClass("ghost", "sm")} self-start`}>
        ‹ Back to approve
      </button>
      {errorLine}

      <div className="grid gap-1.5 sm:grid-cols-3">
        {DECLINE_KINDS.map((k) => (
          <button
            key={k.value}
            type="button"
            aria-pressed={declineKind === k.value}
            onClick={() => setDeclineKind(k.value)}
            className={`flex flex-col gap-0.5 rounded-lg border p-2.5 text-left ${
              declineKind === k.value ? "border-warn bg-warn-soft" : "border-line hover:border-warn-line"
            }`}
          >
            <span className="text-[13px] font-semibold">{k.title}</span>
            <span className="text-xs text-ink-2">{k.consequence}</span>
          </button>
        ))}
      </div>

      {declineKind === "hold" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="hold-sub-reason" className={labelClass}>
              Vendor issue
            </label>
            <select id="hold-sub-reason" value={subReason} onChange={(e) => setSubReason(e.target.value as HoldSubReason)} className={inputClass}>
              {HOLD_SUB_REASONS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="hold-review-on" className={labelClass}>
              Review on
            </label>
            <input id="hold-review-on" type="date" value={reviewOn} onChange={(e) => setReviewOn(e.target.value)} className={`${inputClass} font-mono`} />
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <label htmlFor="decline-reason" className={labelClass}>
          Reason <span className="font-normal text-ink-3">the requester will read this</span>
        </label>
        <textarea id="decline-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className={inputClass} />
      </div>

      <button
        type="button"
        disabled={pending || !reason.trim() || (declineKind === "hold" && !reviewOn)}
        onClick={() => {
          if (declineKind === "return") void run(() => returnToRequesterAction(requestId, { reason }));
          else if (declineKind === "hold") void run(() => holdAction(requestId, { reviewOn, subReason, reason }));
          else void run(() => rejectAction(requestId, { reason }));
        }}
        className={buttonClass(declineKind === "reject" ? "danger" : "primary", "md", true)}
      >
        {declineKind === "return" ? "Return to the requester" : declineKind === "hold" ? `Place on hold${reviewOn ? ` until ${reviewOn}` : ""}` : "Reject — closed unpaid"}
      </button>
    </div>
  );
}
