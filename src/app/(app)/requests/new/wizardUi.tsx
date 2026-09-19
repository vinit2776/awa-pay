import { useId, type ReactNode } from "react";
import { isLowConfidence, type ExtractedField } from "@/capture/confirmFields";

// Shared building blocks for the raise-a-request wizard. Tap targets follow
// the brief for a low-tech requester on a phone: buttons at least 54px tall,
// inputs at least 48px, all text 16px or larger. Colours come from the
// design tokens (src/app/globals.css); the sizes deliberately don't follow
// the denser desk screens.

export const inputClass =
  "min-h-12 w-full rounded-lg border border-line bg-surface px-3 py-2 text-base text-ink placeholder:text-ink-3 focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-accent-soft";

const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export const primaryButtonClass = `min-h-[54px] w-full rounded-lg bg-accent px-4 text-base font-semibold text-accent-ink transition-colors hover:bg-accent/90 disabled:opacity-45 ${focusRing}`;
export const secondaryButtonClass = `min-h-[54px] rounded-lg border border-line bg-surface px-4 text-base font-medium text-ink transition-colors hover:bg-sunk disabled:opacity-45 ${focusRing}`;
export const linkButtonClass = `min-h-12 px-2 text-base font-medium text-accent underline underline-offset-4 disabled:opacity-45 ${focusRing}`;
export const dangerLinkClass = `min-h-12 px-2 text-base font-medium text-danger underline underline-offset-4 disabled:opacity-45 ${focusRing}`;

// Replaces the old flat-0.8 badge. Whether a read is "unsure" comes from
// src/capture/confirmFields.ts — the same floors the server escalates on.
export function FieldCheck({ field, confidence, confirmed }: { field: ExtractedField; confidence: number | undefined; confirmed: boolean }) {
  if (confidence === undefined) return null;
  if (!isLowConfidence(field, confidence)) return <span className="text-sm font-medium text-ok">✓ Read from your photo</span>;
  if (confirmed) return <span className="text-sm font-medium text-ok">✓ Checked</span>;
  return <span className="text-sm font-semibold text-warn">! Check this against your photo</span>;
}

export function StepHeader({ step, total }: { step: number; total: number }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-base text-ink-2">
        Step {step} of {total}
      </p>
      <div className="flex gap-1.5" role="progressbar" aria-valuemin={1} aria-valuemax={total} aria-valuenow={step} aria-label="Progress">
        {Array.from({ length: total }, (_, i) => (
          <div key={i} className={`h-1.5 flex-1 rounded-full ${i < step ? "bg-accent" : "bg-line"}`} />
        ))}
      </div>
    </div>
  );
}

export function Field({
  label,
  hint,
  badge,
  children,
}: {
  label: string;
  hint?: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-base font-medium">
        <span>{label}</span>
        {badge}
      </span>
      {children}
      {hint && <span className="text-base text-ink-2">{hint}</span>}
    </label>
  );
}

// A boxed message at the wizard's own 16px size — the shared Notice is
// set for the desk screens and would break the brief's minimum here.
export function Callout({ tone, title, children }: { tone: "warn" | "danger" | "info"; title?: string; children: ReactNode }) {
  const box = { warn: "border-warn-line bg-warn-soft", danger: "border-danger-line bg-danger-soft", info: "border-transparent bg-info-soft" }[tone];
  const heading = { warn: "text-warn", danger: "text-danger", info: "text-info" }[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`flex flex-col gap-1.5 rounded-lg border p-3 text-base text-ink ${box}`}>
      {title && <p className={`font-semibold ${heading}`}>{title}</p>}
      {children}
    </div>
  );
}

// A big selectable card, exposed as a radio in a radiogroup.
export function ChoiceCard({
  title,
  sub,
  selected,
  onSelect,
}: {
  title: string;
  sub: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`flex min-h-[72px] w-full flex-col items-start gap-1 rounded-xl border-2 px-4 py-3 text-left transition-colors ${focusRing} ${
        selected ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-ink-3"
      }`}
    >
      <span className="text-base font-semibold">{title}</span>
      <span className="text-base text-ink-2">{sub}</span>
    </button>
  );
}

export function Chip({ label, selected, onSelect }: { label: string; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`min-h-12 rounded-full border-2 px-4 text-base transition-colors ${focusRing} ${
        selected ? "border-accent bg-accent font-semibold text-accent-ink" : "border-line bg-surface text-ink hover:border-ink-3"
      }`}
    >
      {label}
    </button>
  );
}

export function ChipGroup({ label, children }: { label: string; children: ReactNode }) {
  const labelId = useId();
  return (
    <div className="flex flex-col gap-2">
      <p id={labelId} className="text-base font-medium">
        {label}
      </p>
      <div role="radiogroup" aria-labelledby={labelId} className="flex flex-wrap gap-2">
        {children}
      </div>
    </div>
  );
}

export function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-base text-danger">
      {message}
    </p>
  );
}

export function CameraIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg width="72" height="72" viewBox="0 0 72 72" fill="none" aria-hidden="true" className="text-ok">
      <circle cx="36" cy="36" r="33" stroke="currentColor" strokeWidth="3" />
      <path d="M22 37l10 10 18-21" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Spinner() {
  return (
    <svg className="animate-spin motion-reduce:animate-none" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// Every step starts with one of these; the wizard moves focus to it on each
// step change so screen readers and keyboard users land at the top.
export function StepTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h2 tabIndex={-1} className="text-2xl font-semibold tracking-tight text-balance outline-none">
        {title}
      </h2>
      {sub && <p className="text-base text-ink-2">{sub}</p>}
    </div>
  );
}
