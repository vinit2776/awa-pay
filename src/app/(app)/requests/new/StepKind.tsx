"use client";

import type { Kind, PatchForm, WizardForm } from "./wizardTypes";
import { ChoiceCard, ErrorLine, StepTitle } from "./wizardUi";

export function StepKind({ form, patch, error }: { form: WizardForm; patch: PatchForm; error: string | null }) {
  // Switching kind clears the payment answers, which mean different things
  // for a bill and for an advance.
  function choose(kind: Kind) {
    if (form.kind === kind) return;
    patch({ kind, payMode: "full", payNow: "", payNowReason: "", finalBillWhen: null });
  }

  return (
    <div className="flex flex-col gap-5">
      <StepTitle title="What is this payment for?" />
      <div role="radiogroup" aria-label="What is this payment for?" className="flex flex-col gap-3">
        <ChoiceCard
          title="Work is done or goods arrived"
          sub="I have the bill for it."
          selected={form.kind === "invoice"}
          onSelect={() => choose("invoice")}
        />
        <ChoiceCard
          title="Vendor wants money first"
          sub="Before they start. I have their quotation."
          selected={form.kind === "advance"}
          onSelect={() => choose("advance")}
        />
      </div>
      <ErrorLine message={error} />
    </div>
  );
}
