import { useId, type ReactNode } from "react";

// Shared building blocks for the raise-a-request wizard. Tap targets follow
// the brief for a low-tech requester on a phone: buttons at least 54px tall,
// inputs at least 48px, all text 16px or larger.

export const inputClass =
  "min-h-12 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-base dark:border-zinc-700 dark:bg-black";

const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black dark:focus-visible:outline-white";

export const primaryButtonClass = `min-h-[54px] w-full rounded-lg bg-black px-4 text-base font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-black ${focusRing}`;
export const secondaryButtonClass = `min-h-[54px] rounded-lg border border-zinc-300 px-4 text-base font-medium disabled:opacity-50 dark:border-zinc-700 ${focusRing}`;

export function ConfidenceBadge({ confidence }: { confidence: number | undefined }) {
  if (confidence === undefined) return null;
  return confidence >= 0.8 ? (
    <span className="text-sm font-normal text-green-700 dark:text-green-400">✓ High confidence</span>
  ) : (
    <span className="text-sm font-normal text-amber-700 dark:text-amber-400">! Low confidence — please confirm</span>
  );
}

export function StepHeader({ step, total }: { step: number; total: number }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-base text-zinc-600 dark:text-zinc-400">
        Step {step} of {total}
      </p>
      <div className="flex gap-1.5" role="progressbar" aria-valuemin={1} aria-valuemax={total} aria-valuenow={step} aria-label="Progress">
        {Array.from({ length: total }, (_, i) => (
          <div
            key={i}
            className={`h-1.5 flex-1 rounded-full ${i < step ? "bg-black dark:bg-white" : "bg-zinc-200 dark:bg-zinc-800"}`}
          />
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
      <span className="flex items-center justify-between gap-2 text-base font-medium">
        <span>{label}</span>
        {badge}
      </span>
      {children}
      {hint && <span className="text-base text-zinc-600 dark:text-zinc-400">{hint}</span>}
    </label>
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
      className={`flex min-h-[72px] w-full flex-col items-start gap-1 rounded-lg border-2 px-4 py-3 text-left ${focusRing} ${
        selected
          ? "border-black bg-zinc-100 dark:border-white dark:bg-zinc-900"
          : "border-zinc-300 dark:border-zinc-700"
      }`}
    >
      <span className="text-base font-semibold">{title}</span>
      <span className="text-base text-zinc-600 dark:text-zinc-400">{sub}</span>
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
      className={`min-h-12 rounded-full border-2 px-4 text-base ${focusRing} ${
        selected
          ? "border-black bg-black font-semibold text-white dark:border-white dark:bg-white dark:text-black"
          : "border-zinc-300 dark:border-zinc-700"
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
    <p role="alert" className="text-base text-red-600 dark:text-red-400">
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
    <svg width="72" height="72" viewBox="0 0 72 72" fill="none" aria-hidden="true">
      <circle cx="36" cy="36" r="33" stroke="currentColor" strokeWidth="3" className="text-green-600 dark:text-green-400" />
      <path d="M22 37l10 10 18-21" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" className="text-green-600 dark:text-green-400" />
    </svg>
  );
}

export function Spinner() {
  return (
    <svg className="animate-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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
      <h2 tabIndex={-1} className="text-2xl font-semibold outline-none">
        {title}
      </h2>
      {sub && <p className="text-base text-zinc-600 dark:text-zinc-400">{sub}</p>}
    </div>
  );
}
