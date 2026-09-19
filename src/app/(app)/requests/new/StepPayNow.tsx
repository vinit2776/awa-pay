"use client";

import { formatMinorUnits } from "@/lib/money";
import { FINAL_BILL_OPTIONS, type PatchForm, type WizardForm } from "./wizardTypes";
import { amountToMinor, cleanAmount, minorToPlain, percentOfMinor } from "./wizardMoney";
import { Chip, ChipGroup, ChoiceCard, ErrorLine, Field, StepTitle, inputClass } from "./wizardUi";

const ADVANCE_PERCENTS = [25, 30, 40, 50];
const ADVANCE_REASONS = ["Will not start without it", "To buy materials", "To book a slot"];
const PART_REASONS = ["Work not fully done", "Some items disputed", "Pay the rest later"];

export function StepPayNow({
  form,
  patch,
  totalMinor,
  error,
}: {
  form: WizardForm;
  patch: PatchForm;
  totalMinor: number;
  error: string | null;
}) {
  const total = formatMinorUnits(totalMinor);

  if (form.kind === "advance") {
    const payMinor = amountToMinor(form.payNow);
    const selectedPct = ADVANCE_PERCENTS.find((p) => cleanAmount(form.payNow) === minorToPlain(percentOfMinor(totalMinor, p)));
    const showShare = payMinor !== null && payMinor <= totalMinor;

    return (
      <div className="flex flex-col gap-6">
        <StepTitle title="How much does the vendor want first?" sub={`Full price: ${total}`} />

        <ChipGroup label="Pick a share of the price">
          {ADVANCE_PERCENTS.map((p) => (
            <Chip
              key={p}
              label={`${p}%`}
              selected={selectedPct === p}
              onSelect={() => patch({ payNow: minorToPlain(percentOfMinor(totalMinor, p)) })}
            />
          ))}
        </ChipGroup>

        <Field label="Or type an amount">
          <input
            type="text"
            inputMode="decimal"
            value={form.payNow}
            onChange={(e) => patch({ payNow: e.target.value })}
            placeholder="0.00"
            className={inputClass}
          />
        </Field>

        {showShare && (
          <p className="rounded-lg bg-sunk px-3 py-3 text-base" aria-live="polite">
            <strong className="font-mono tabular-nums">{formatMinorUnits(payMinor)}</strong> is{" "}
            <strong>{Math.round((payMinor * 100) / totalMinor)}%</strong> of <strong className="font-mono tabular-nums">{total}</strong>
          </p>
        )}

        <ChipGroup label="Why first?">
          {ADVANCE_REASONS.map((r) => (
            <Chip key={r} label={r} selected={form.payNowReason === r} onSelect={() => patch({ payNowReason: r })} />
          ))}
        </ChipGroup>

        <ChipGroup label="When will the final bill come?">
          {FINAL_BILL_OPTIONS.map((o) => (
            <Chip key={o.value} label={o.label} selected={form.finalBillWhen === o.value} onSelect={() => patch({ finalBillWhen: o.value })} />
          ))}
        </ChipGroup>

        <ErrorLine message={error} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <StepTitle title="How much should be paid now?" sub={`Total on the bill: ${total}`} />
      <div role="radiogroup" aria-label="How much should be paid now?" className="flex flex-col gap-3">
        <ChoiceCard
          title="Pay all of it"
          sub={`Pay ${total} now.`}
          selected={form.payMode === "full"}
          onSelect={() => patch({ payMode: "full", payNow: "", payNowReason: "" })}
        />
        <ChoiceCard
          title="Pay only part now"
          sub="The rest will be paid later."
          selected={form.payMode === "part"}
          onSelect={() => patch({ payMode: "part" })}
        />
      </div>

      {form.payMode === "part" && (
        <>
          <Field label="How much now?">
            <input
              type="text"
              inputMode="decimal"
              value={form.payNow}
              onChange={(e) => patch({ payNow: e.target.value })}
              placeholder="0.00"
              className={inputClass}
            />
          </Field>
          <ChipGroup label="Why only part?">
            {PART_REASONS.map((r) => (
              <Chip
                key={r}
                label={r}
                selected={form.payNowReason === r}
                onSelect={() => patch({ payNowReason: form.payNowReason === r ? "" : r })}
              />
            ))}
          </ChipGroup>
        </>
      )}

      <ErrorLine message={error} />
    </div>
  );
}
