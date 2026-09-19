"use client";

import { isLowConfidence, type ExtractedField } from "@/capture/confirmFields";
import type { FieldConfidence } from "./useBillCapture";
import type { PatchForm, WizardForm } from "./wizardTypes";
import { ErrorLine, Field, FieldCheck, StepTitle, inputClass, secondaryButtonClass } from "./wizardUi";

export function StepDetails({
  form,
  patch,
  confidence,
  confirmed,
  onConfirm,
  extractionNote,
  readingSkipped,
  error,
}: {
  form: WizardForm;
  patch: PatchForm;
  confidence: FieldConfidence;
  confirmed: ReadonlySet<ExtractedField>;
  onConfirm: (field: ExtractedField) => void;
  extractionNote: string | null;
  readingSkipped: boolean;
  error: string | null;
}) {
  const isInvoice = form.kind !== "advance";
  const typedByHand = !!extractionNote || readingSkipped;

  // Editing a field counts as checking it — the requester has looked.
  function edit(field: ExtractedField, partial: Partial<WizardForm>) {
    patch(partial);
    onConfirm(field);
  }

  // The "Looks right" button sits outside the <label>, so tapping it never
  // lands focus in the input instead.
  function looksRight(field: ExtractedField) {
    if (!isLowConfidence(field, confidence[field]) || confirmed.has(field)) return null;
    return (
      <button type="button" onClick={() => onConfirm(field)} className={`${secondaryButtonClass} -mt-2 self-start`}>
        Looks right
      </button>
    );
  }

  const check = (field: ExtractedField) => <FieldCheck field={field} confidence={confidence[field]} confirmed={confirmed.has(field)} />;

  return (
    <div className="flex flex-col gap-5">
      <StepTitle
        title="Check the details"
        sub={typedByHand ? "Fill these in from your photo." : "We read these from your photo. Fix anything that is wrong."}
      />
      {extractionNote && (
        <p className="text-base text-warn">Couldn&apos;t read this {isInvoice ? "bill" : "quotation"} automatically — enter the details below.</p>
      )}

      <Field label={isInvoice ? "Who is the bill from?" : "Who is the quotation from?"} badge={check("vendor")}>
        <input type="text" value={form.vendor} onChange={(e) => edit("vendor", { vendor: e.target.value })} className={inputClass} />
      </Field>
      {looksRight("vendor")}

      <Field label={isInvoice ? "Bill number" : "Quotation number (if any)"} badge={check("invoiceNo")}>
        <input type="text" value={form.docNo} onChange={(e) => edit("invoiceNo", { docNo: e.target.value })} className={`${inputClass} font-mono`} />
      </Field>
      {looksRight("invoiceNo")}

      {isInvoice && (
        <>
          <Field label="Bill date" badge={check("invoiceDate")}>
            <input type="date" value={form.invoiceDate} onChange={(e) => edit("invoiceDate", { invoiceDate: e.target.value })} className={`${inputClass} font-mono`} />
          </Field>
          {looksRight("invoiceDate")}
        </>
      )}

      <Field
        label={isInvoice ? "Total on the bill" : "Full price of the work"}
        hint={isInvoice ? "The final amount, with tax." : "The whole price, not only the part paid first."}
        badge={check("amount")}
      >
        <input
          type="text"
          inputMode="decimal"
          value={form.amount}
          onChange={(e) => edit("amount", { amount: e.target.value })}
          placeholder="0.00"
          className={`${inputClass} font-mono tabular-nums`}
        />
      </Field>
      {looksRight("amount")}

      {isInvoice && (
        <details className="rounded-lg border border-line bg-surface" open={isLowConfidence("gstin", confidence.gstin) && !confirmed.has("gstin")}>
          <summary className="flex min-h-12 cursor-pointer items-center px-3 text-base font-medium">More details</summary>
          <div className="flex flex-col gap-3 px-3 pb-3">
            <Field label="GSTIN on bill" badge={check("gstin")}>
              <input type="text" value={form.gstin} onChange={(e) => edit("gstin", { gstin: e.target.value })} className={`${inputClass} font-mono uppercase`} />
            </Field>
            {looksRight("gstin")}
          </div>
        </details>
      )}

      <ErrorLine message={error} />
    </div>
  );
}
