"use client";

import type { FieldConfidence } from "./useBillCapture";
import type { PatchForm, WizardForm } from "./wizardTypes";
import { ConfidenceBadge, ErrorLine, Field, StepTitle, inputClass } from "./wizardUi";

export function StepDetails({
  form,
  patch,
  confidence,
  extractionNote,
  error,
}: {
  form: WizardForm;
  patch: PatchForm;
  confidence: FieldConfidence;
  extractionNote: string | null;
  error: string | null;
}) {
  const isInvoice = form.kind !== "advance";

  return (
    <div className="flex flex-col gap-5">
      <StepTitle
        title="Check the details"
        sub={extractionNote ? "Fill these in from your photo." : "We read these from your photo. Fix anything that is wrong."}
      />
      {extractionNote && (
        <p className="text-base text-amber-700 dark:text-amber-400">
          Couldn&apos;t read this {isInvoice ? "bill" : "quotation"} automatically — enter the details below.
        </p>
      )}

      <Field
        label={isInvoice ? "Who is the bill from?" : "Who is the quotation from?"}
        badge={<ConfidenceBadge confidence={confidence.vendor} />}
      >
        <input type="text" value={form.vendor} onChange={(e) => patch({ vendor: e.target.value })} className={inputClass} />
      </Field>

      <Field label={isInvoice ? "Bill number" : "Quotation number (if any)"} badge={<ConfidenceBadge confidence={confidence.invoiceNo} />}>
        <input type="text" value={form.docNo} onChange={(e) => patch({ docNo: e.target.value })} className={inputClass} />
      </Field>

      {isInvoice && (
        <Field label="Bill date" badge={<ConfidenceBadge confidence={confidence.invoiceDate} />}>
          <input type="date" value={form.invoiceDate} onChange={(e) => patch({ invoiceDate: e.target.value })} className={inputClass} />
        </Field>
      )}

      <Field
        label={isInvoice ? "Total on the bill" : "Full price of the work"}
        hint={isInvoice ? "The final amount, with tax." : "The whole price, not only the part paid first."}
        badge={<ConfidenceBadge confidence={confidence.amount} />}
      >
        <input
          type="text"
          inputMode="decimal"
          value={form.amount}
          onChange={(e) => patch({ amount: e.target.value })}
          placeholder="0.00"
          className={inputClass}
        />
      </Field>

      {isInvoice && (
        <details className="rounded-lg border border-zinc-300 dark:border-zinc-700">
          <summary className="flex min-h-12 cursor-pointer items-center px-3 text-base font-medium">More details</summary>
          <div className="px-3 pb-3">
            <Field label="GSTIN on bill" badge={<ConfidenceBadge confidence={confidence.gstin} />}>
              <input type="text" value={form.gstin} onChange={(e) => patch({ gstin: e.target.value })} className={inputClass} />
            </Field>
          </div>
        </details>
      )}

      <ErrorLine message={error} />
    </div>
  );
}
