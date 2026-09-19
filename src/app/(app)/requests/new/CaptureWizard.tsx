"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { submitRequestAction } from "./actions";
import { attachInvoiceAction } from "@/app/(app)/requests/[id]/actions";
import { enqueueDraft } from "@/capture/draftQueue";
import type { DuplicateMatch } from "@/duplicates/duplicateCore";
import { formatMinorUnits } from "@/lib/money";
import { StepDetails } from "./StepDetails";
import { StepKind } from "./StepKind";
import { StepPayNow } from "./StepPayNow";
import { StepPhoto } from "./StepPhoto";
import { StepReview } from "./StepReview";
import { useBillCapture } from "./useBillCapture";
import { FINAL_BILL_OPTIONS, TOTAL_STEPS, type WizardForm } from "./wizardTypes";
import { amountToMinor, cleanAmount, isoDateInDays, minorToPlain } from "./wizardMoney";
import { CheckIcon, StepHeader, primaryButtonClass, secondaryButtonClass } from "./wizardUi";

type Outcome =
  | { type: "sent"; ref: string; requestId: string; kind: "invoice" | "advance"; vendor: string }
  // The bill was the tax invoice for an advance already paid: attached to
  // that request, nothing new raised.
  | { type: "attached"; ref: string; requestId: string }
  | { type: "queued" };

type WizardProps = {
  departments: { id: string; name: string }[];
  linkedRequestId?: string | null;
  canOverrideDuplicate?: boolean;
};

// "Raise another" remounts the whole run with a new key, which resets every
// field, attachment and error in one move. The reconsideration link only ever
// belongs to the first request raised from this page.
export function CaptureWizard(props: WizardProps) {
  const [run, setRun] = useState(0);
  return (
    <WizardRun
      key={run}
      {...props}
      linkedRequestId={run === 0 ? props.linkedRequestId : null}
      onRaiseAnother={() => setRun((r) => r + 1)}
    />
  );
}

function WizardRun({
  departments,
  linkedRequestId,
  canOverrideDuplicate,
  onRaiseAnother,
}: WizardProps & { onRaiseAnother: () => void }) {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<WizardForm>({
    kind: null,
    docNo: "",
    vendor: "",
    invoiceDate: "",
    amount: "",
    gstin: "",
    payMode: "full",
    payNow: "",
    payNowReason: "",
    finalBillWhen: null,
    departmentId: departments[0]?.id ?? "",
    note: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // Open advances the vendor on this bill already has (the sixth duplicate
  // verdict). Set by a refused submit; belongs to the vendor as typed, so a
  // change to vendor or GSTIN clears it.
  const [openAdvances, setOpenAdvances] = useState<DuplicateMatch[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);

  function patch(partial: Partial<WizardForm>) {
    setForm((f) => ({ ...f, ...partial }));
    setError(null);
    if ("vendor" in partial || "gstin" in partial) setOpenAdvances([]);
  }

  const capture = useBillCapture({
    // Real extraction only: whatever the model read goes straight into the
    // fields, blank stays blank. The document number lands in the one field
    // the kind of request uses (bill number or quotation number).
    onExtracted: (fill) =>
      setForm((f) => ({
        ...f,
        vendor: fill.vendor,
        amount: fill.amount,
        docNo: fill.invoiceNo,
        invoiceDate: fill.invoiceDate,
        gstin: fill.gstin,
      })),
  });

  // Move focus to the step title whenever the step changes.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    containerRef.current?.querySelector<HTMLElement>("h2")?.focus();
  }, [step]);

  const isAdvance = form.kind === "advance";
  const totalMinor = amountToMinor(form.amount);
  const typedPayNowMinor = amountToMinor(form.payNow);
  const paysPart = isAdvance || form.payMode === "part";
  const hasPages = capture.attachments.length > 0 || capture.offlineQueue.length > 0;
  const busy = capture.attaching || capture.extracting;

  function validate(forStep: number): string | null {
    switch (forStep) {
      case 1:
        return form.kind ? null : "Pick one to continue.";
      case 2:
        return hasPages ? null : "Add a photo to continue.";
      case 3:
        return form.vendor.trim() && totalMinor !== null ? null : "Fill in who it is from and the total.";
      case 4: {
        if (totalMinor === null) return "Fill in who it is from and the total.";
        const total = formatMinorUnits(totalMinor);
        if (isAdvance) {
          if (typedPayNowMinor === null || typedPayNowMinor > totalMinor) {
            return `Enter how much to pay first. It can't be more than ${total}.`;
          }
          if (!form.payNowReason || !form.finalBillWhen) return "Pick why, and when the final bill will come.";
          return null;
        }
        if (form.payMode === "part" && (typedPayNowMinor === null || typedPayNowMinor >= totalMinor)) {
          return `Enter an amount that is less than ${total}.`;
        }
        return null;
      }
      default:
        return form.departmentId ? null : "Pick a department.";
    }
  }

  function goNext() {
    const problem = validate(step);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setStep((s) => Math.min(TOTAL_STEPS, s + 1));
  }

  function goBack() {
    setError(null);
    setStep((s) => Math.max(1, s - 1));
  }

  // What the server action (and the offline draft) take, in one place so the
  // two paths cannot drift.
  function buildFields() {
    const partPay = paysPart && typedPayNowMinor !== null;
    const finalBill = FINAL_BILL_OPTIONS.find((o) => o.value === form.finalBillWhen);
    return {
      departmentId: form.departmentId,
      amount: cleanAmount(form.amount),
      invoiceNo: isAdvance ? "" : form.docNo.trim(),
      invoiceDate: isAdvance ? "" : form.invoiceDate,
      vendor: form.vendor.trim(),
      gstinOnBill: isAdvance ? "" : form.gstin.trim(),
      note: form.note,
      kind: form.kind ?? ("invoice" as const),
      payNow: partPay ? minorToPlain(typedPayNowMinor) : "",
      payNowReason: partPay ? form.payNowReason : "",
      quotationNo: isAdvance ? form.docNo.trim() : "",
      invoiceExpectedBy: isAdvance && finalBill?.days ? isoDateInDays(finalBill.days) : "",
    };
  }

  async function handleSubmit(overrideDuplicateReason?: string, declineOpenAdvanceReason?: string) {
    setSubmitting(true);
    setError(null);
    try {
      const fields = buildFields();

      // Offline this whole capture, or connectivity dropped partway
      // through — queue locally rather than attempt a submit that has
      // nothing real to point at yet (no attachments actually reached
      // R2). The draft flushes itself the next time the app opens with a
      // connection (src/capture/DraftFlusher.tsx).
      if (capture.isOfflineCapture || (capture.attachments.length === 0 && capture.offlineQueue.length > 0)) {
        await enqueueDraft({ ...fields, attachments: capture.offlineQueue });
        setOutcome({ type: "queued" });
        return;
      }

      const result = await submitRequestAction({
        ...fields,
        attachments: capture.attachments.map((a) => ({
          fileId: a.fileId,
          storageKey: a.storageKey,
          mime: a.mime,
          byteLength: a.byteLength,
          sha256: a.sha256,
        })),
        linkedRequestId,
        overrideDuplicateReason,
        declineOpenAdvanceReason,
        extraction: capture.extractionAttemptId
          ? { attemptId: capture.extractionAttemptId, phash: capture.extractionPhash }
          : undefined,
      });
      if (result && !result.ok && result.duplicate?.verdict === "matched_advance") {
        // A question, not an error: the card in the review step asks it.
        setOpenAdvances(result.openAdvances ?? [result.duplicate.match]);
        return;
      }
      if (!result || !result.ok) {
        setError(result?.error ?? "Something went wrong. Try again.");
        capture.applyDuplicate(result?.duplicate?.match ?? null, result?.duplicate?.verdict ?? null);
        return;
      }
      setOutcome({ type: "sent", ref: result.ref, requestId: result.requestId, kind: fields.kind, vendor: fields.vendor });
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // "Yes, this is the invoice for that advance": the bill goes onto the
  // advance the requester raised, through the same attach the request's own
  // page offers. No second request is created.
  async function handleAttach(match: DuplicateMatch) {
    if (!match.advance) return;
    setSubmitting(true);
    setError(null);
    try {
      const fields = buildFields();
      const result = await attachInvoiceAction(match.requestId, {
        invoiceNo: fields.invoiceNo,
        invoiceDate: fields.invoiceDate,
        amountMinor: amountToMinor(fields.amount) ?? 0,
        attachments: capture.attachments.map((a) => ({
          fileId: a.fileId,
          storageKey: a.storageKey,
          mime: a.mime,
          byteLength: a.byteLength,
          sha256: a.sha256,
        })),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOutcome({ type: "attached", ref: match.advance.ref, requestId: match.requestId });
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (outcome) {
    return (
      <div className="flex w-full max-w-sm flex-col items-center gap-5 text-center">
        <CheckIcon />
        {outcome.type === "attached" ? (
          <>
            <h2 className="text-2xl font-semibold">Attached to {outcome.ref}</h2>
            <p className="text-base text-zinc-600 dark:text-zinc-400">
              That bill is the invoice for the advance already paid. It is with the payer for the balance. Nothing new was raised, so it cannot be paid twice.
            </p>
          </>
        ) : outcome.type === "sent" ? (
          <>
            <h2 className="text-2xl font-semibold">Sent to your approver</h2>
            <p className="text-lg font-semibold">{outcome.ref}</p>
            <p className="text-base text-zinc-600 dark:text-zinc-400">
              {outcome.kind === "advance"
                ? `Once it is paid, we will remind you to attach the final bill from ${outcome.vendor}.`
                : "You will get a message if anyone has a question."}
            </p>
          </>
        ) : (
          <>
            <h2 className="text-2xl font-semibold">Saved on this phone</h2>
            <p className="text-base text-zinc-600 dark:text-zinc-400">
              No connection right now. This request is saved on this device and will send itself next time the app is open with signal.
            </p>
          </>
        )}
        <div className="flex w-full flex-col gap-3">
          {(outcome.type === "sent" || outcome.type === "attached") && (
            <Link href={`/requests/${outcome.requestId}`} className={`${primaryButtonClass} flex items-center justify-center`}>
              See this request
            </Link>
          )}
          <Link href="/requests" className={`${secondaryButtonClass} flex items-center justify-center`}>
            My requests
          </Link>
          <button type="button" onClick={onRaiseAnother} className={secondaryButtonClass}>
            Raise another
          </button>
        </div>
      </div>
    );
  }

  const isLastStep = step === TOTAL_STEPS;
  const offlineNow = capture.isOfflineCapture || (capture.attachments.length === 0 && capture.offlineQueue.length > 0);
  const payNowMinor = paysPart && typedPayNowMinor !== null ? typedPayNowMinor : (totalMinor ?? 0);

  return (
    <div ref={containerRef} className="flex w-full max-w-sm flex-col gap-6">
      <StepHeader step={step} total={TOTAL_STEPS} />

      {step === 1 && <StepKind form={form} patch={patch} error={error} />}
      {step === 2 && form.kind && <StepPhoto kind={form.kind} capture={capture} error={error} />}
      {step === 3 && (
        <StepDetails
          form={form}
          patch={patch}
          confidence={capture.fieldConfidence}
          extractionNote={capture.extractionNote}
          error={error}
        />
      )}
      {step === 4 && totalMinor !== null && <StepPayNow form={form} patch={patch} totalMinor={totalMinor} error={error} />}
      {step === 5 && totalMinor !== null && (
        <StepReview
          form={form}
          patch={patch}
          totalMinor={totalMinor}
          payNowMinor={payNowMinor}
          departments={departments}
          duplicate={capture.duplicate}
          duplicateVerdict={capture.duplicateVerdict}
          canOverrideDuplicate={canOverrideDuplicate}
          submitting={submitting}
          onOverride={(reason) => void handleSubmit(reason)}
          openAdvances={openAdvances}
          onAttachToAdvance={(match) => void handleAttach(match)}
          onDeclineOpenAdvance={(reason) => void handleSubmit(undefined, reason)}
          error={error}
        />
      )}

      {isLastStep && offlineNow && (
        <p className="text-base text-amber-700 dark:text-amber-400">
          No connection — this will be saved on your phone and sent once you&apos;re back on signal.
        </p>
      )}

      <div className="flex gap-3">
        {step > 1 && (
          <button type="button" onClick={goBack} disabled={submitting} className={`${secondaryButtonClass} shrink-0`}>
            Back
          </button>
        )}
        <button
          type="button"
          disabled={submitting || (step === 2 && busy) || (isLastStep && !form.departmentId)}
          onClick={isLastStep ? () => void handleSubmit() : goNext}
          className={primaryButtonClass}
        >
          {isLastStep ? (submitting ? "Sending…" : offlineNow ? "Save to send later" : "Send to approver") : "Next"}
        </button>
      </div>
    </div>
  );
}
