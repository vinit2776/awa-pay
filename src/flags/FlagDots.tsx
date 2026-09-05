import type { Flag } from "@/flags/computeFlags";

const DOT_CLASS: Record<Flag["severity"], string> = {
  red: "bg-red-500 dark:bg-red-400",
  amber: "bg-amber-500 dark:bg-amber-400",
};

// "Each one appears as a dot with a reason on hover" (concept-v2.html §07)
// — the browser's native title tooltip is that hover, no extra JS needed.
export function FlagDots({ flags }: { flags: Flag[] }) {
  if (flags.length === 0) return null;
  return (
    <span className="ml-2 inline-flex items-center gap-1 align-middle">
      {flags.map((f) => (
        <span key={f.key} title={f.reason} className={`inline-block h-[7px] w-[7px] rounded-full ${DOT_CLASS[f.severity]}`} />
      ))}
    </span>
  );
}
