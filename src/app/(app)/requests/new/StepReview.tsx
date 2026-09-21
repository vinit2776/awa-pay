"use client";

import { useState } from "react";
import { formatMinorUnits } from "@/lib/money";
import type { DuplicateMatch, DuplicateVerdict } from "@/duplicates/duplicateCore";
import type { PatchForm, WizardForm } from "./wizardTypes";
import { Callout, ErrorLine, Field, StepTitle, inputClass, linkButtonClass } from "./wizardUi";

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
  const stageText = (stage: string) => stage.replaceAll("_", " ");
  const money = (text: string) => <strong className="font-mono tabular-nums">{text}</strong>;

  return (
    <div className="flex flex-col gap-5">
      <StepTitle title="Check and send" />

      <p className="rounded-xl bg-sunk px-4 py-4 text-base leading-relaxed">
        {form.kind === "advance" ? (
          <>
            You are asking to pay <strong>{vendor}</strong> {money(now)} now, as an advance on a {money(total)} job. The final bill will come later.
          </>
        ) : payNowMinor < totalMinor ? (
          <>
            You are asking to pay <strong>{vendor}</strong> {money(now)} now, part of a {money(total)} bill.
          </>
        ) : (
          <>
            You are asking to pay <strong>{vendor}</strong> {money(total)} now for their bill.
          </>
        )}
      </p>

      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-line-soft pb-3">
        <div className="flex flex-1 flex-col">
          <span className="text-base text-ink-2">Department</span>
          {changingDepartment ? (
            <select value={form.departmentId} onChange={(e) => patch({ departmentId: e.target.value })} aria-label="Department" className={`${inputClass} mt-1`}>
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
          <button type="button" onClick={() => setChangingDepartment((v) => !v)} className={linkButtonClass}>
            {changingDepartment ? "Done" : "Change"}
          </button>
        )}
      </div>

      <Field label="Anything the approver should know? (optional)">
        <textarea value={form.note} onChange={(e) => patch({ note: e.target.value })} rows={3} className={`${inputClass} min-h-24`} />
      </Field>

      {duplicate && duplicateVerdict === "warned_open" && (
        <Callout tone="warn" title="Seen this before?">
          <p>
            The same file is already on a request that is {stageText(duplicate.stage)}
            {duplicate.invoiceDate && <>, invoiced {duplicate.invoiceDate}</>}. Check you&apos;re not raising it twice.
          </p>
        </Callout>
      )}

      {duplicate && duplicateVerdict === "blocked_paid" && (
        <Callout tone="danger" title="This looks like a bill that was already paid">
          {duplicate.viewableByActor ? (
            <p>
              It matches a request that is {stageText(duplicate.stage)}
              {duplicate.reference && (
                <>
                  , UTR <span className="font-mono">{duplicate.reference}</span>
                </>
              )}
              {duplicate.invoiceDate && <>, invoiced {duplicate.invoiceDate}</>}.
            </p>
          ) : (
            <p>It matches a request in a department you can&apos;t see{duplicate.viewerHint && <> — {duplicate.viewerHint}</>}.</p>
          )}
          {canOverrideDuplicate && (
            <div className="flex flex-col gap-2 border-t border-danger-line pt-2">
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
                className="min-h-[54px] self-start rounded-lg border border-danger-line bg-surface px-4 text-base font-medium text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-45"
              >
                Override and send anyway
              </button>
            </div>
          )}
        </Callout>
      )}

      <ErrorLine message={error} />
    </div>
  );
}
