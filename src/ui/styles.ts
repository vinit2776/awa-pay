// Class strings for native controls. Kept as plain strings rather than
// wrapper components so forms keep using <button>, <input> and <select>
// directly, with every native attribute still available.

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-45";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "border-transparent bg-accent text-accent-ink hover:bg-accent/90",
  secondary: "border-line bg-surface text-ink hover:bg-sunk",
  danger: "border-danger-line bg-surface text-danger hover:bg-danger-soft",
  ghost: "border-transparent bg-transparent text-accent hover:bg-accent-soft",
};

const BUTTON_SIZE = {
  md: "px-3.5 py-2.5 text-sm",
  sm: "px-2.5 py-1.5 text-[13px] rounded-md",
};

export function buttonClass(variant: ButtonVariant = "primary", size: keyof typeof BUTTON_SIZE = "md", full = false): string {
  return `${BUTTON_BASE} ${BUTTON_VARIANT[variant]} ${BUTTON_SIZE[size]}${full ? " w-full" : ""}`;
}

export const inputClass =
  "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-accent-soft";

export const labelClass = "text-[12.5px] font-medium text-ink-2";

export const eyebrowClass = "font-cond text-[11.5px] font-semibold uppercase tracking-[0.08em] text-ink-3";
