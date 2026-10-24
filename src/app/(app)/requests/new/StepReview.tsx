"use client";

import { useState } from "react";
import { formatMinorUnits } from "@/lib/money";
import type { DuplicateMatch, DuplicateVerdict } from "@/duplicates/duplicateCore";
import type { PatchForm, WizardForm } from "./wizardTypes";
import { ErrorLine, Field, StepTitle, inputClass } from "./wizardUi";

export function StepReview({
  form,
  patch,
  totalMinor,
  payNowMinor,
  departments,
  duplicate,
  duplicateVerdict,
  canOverrideDuplicate,
  submitting,
  onOverride,
  error,
}: {
  form: WizardForm;
  patch: PatchForm;
  totalMinor: number;
  // What is being paid now, in paise; equal to totalMinor for a full payment.
  payNowMinor: number;
  departments: { id: string; name: string }[];
  duplicate: DuplicateMatch | null;
  duplicateVerdict: DuplicateVerdict | null;
  canOverrideDuplicate?: boolean;
  submitting: boolean;
  onOverride: (reason: string) => void;
  error: string | null;
}) {
  const [changingDepartment, setChangingDepartment] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const vendor = form.vendor.trim();
  const total = formatMinorUnits(totalMinor);
  const now = formatMinorUnits(payNowMinor);
  const departmentName = departments.find((d) => d.id === form.departmentId)?.name ?? "";

  return (
    <div className="flex flex-col gap-5">
      <StepTitle title="Check and send" />

      <p className="rounded-lg bg-zinc-100 px-4 py-4 text-base leading-relaxed dark:bg-zinc-900">
        {form.kind === "advance" ? (
          <>
            You are asking to pay <strong>{vendor}</strong> <strong>{now}</strong> now, as an advance on a <strong>{total}</strong> job. The
            final bill will come later.
          </>
        ) : payNowMinor < totalMinor ? (
          <>
            You are asking to pay <strong>{vendor}</strong> <strong>{now}</strong> now, part of a <strong>{total}</strong> bill.
          </>
        ) : (
          <>
            You are asking to pay <strong>{vendor}</strong> <strong>{total}</strong> now for their bill.
          </>
        )}
      </p>

      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-zinc-200 pb-3 dark:border-zinc-800">
        <div className="flex flex-col">
          <span className="text-base text-zinc-600 dark:text-zinc-400">Department</span>
          {changingDepartment ? (
            <select
              value={form.departmentId}
              onChange={(e) => patch({ departmentId: e.target.value })}
              aria-label="Department"
              className={`${inputClass} mt-1`}
            >
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-base font-semibold">{departmentName}</span>
          )}
        </div>
        {departments.length > 1 && (
          <button
            type="button"
            onClick={() => setChangingDepartment((v) => !v)}
            className="min-h-12 px-2 text-base font-medium underline underline-offset-4"
          >
            {changingDepartment ? "Done" : "Change"}
          </button>
        )}
      </div>

      <Field label="Anything the approver should know? (optional)">
        <textarea value={form.note} onChange={(e) => patch({ note: e.target.value })} rows={3} className={`${inputClass} min-h-24`} />
      </Field>

      {duplicate && duplicateVerdict === "warned_open" && (
        <div className="rounded-lg border border-amber-400 bg-amber-50 p-3 text-base dark:border-amber-800 dark:bg-amber-950">
          <p className="font-medium">Seen this before?</p>
          <p>
            A byte-identical file was already raised on a request in stage &quot;{duplicate.stage}&quot;
            {duplicate.invoiceDate && <> · invoiced {duplicate.invoiceDate}</>}. Worth a quick check before submitting.
          </p>
        </div>
      )}

      {duplicate && duplicateVerdict === "blocked_paid" && (
        <div className="flex flex-col gap-2 rounded-lg border border-red-400 bg-red-50 p-3 text-base dark:border-red-800 dark:bg-red-950">
          <p className="font-medium">This looks like a duplicate of an already-paid bill.</p>
          {duplicate.viewableByActor ? (
            <p>
              Matches request in stage &quot;{duplicate.stage}&quot;{duplicate.reference && <> · UTR {duplicate.reference}</>}
              {duplicate.invoiceDate && <> · invoiced {duplicate.invoiceDate}</>}.
            </p>
          ) : (
            <p>Matches a request in a department you can&apos;t see{duplicate.viewerHint && <> — {duplicate.viewerHint}</>}.</p>
          )}
          {canOverrideDuplicate && (
            <div className="flex flex-col gap-2 border-t border-red-300 pt-2 dark:border-red-800">
              <textarea
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                placeholder="Reason for overriding this match"
                aria-label="Reason for overriding this match"
                rows={2}
                className={inputClass}
              />
              <button
                type="button"
                disabled={submitting || !overrideReason.trim()}
                onClick={() => onOverride(overrideReason)}
                className="min-h-[54px] self-start rounded-lg border border-red-500 px-4 text-base font-medium text-red-700 disabled:opacity-50 dark:text-red-300"
              >
                Override and submit anyway
              </button>
            </div>
          )}
        </div>
      )}

      <ErrorLine message={error} />
    </div>
  );
}
