import { formatMinorUnits } from "@/lib/money";

// The one way an amount appears on screen: formatMinorUnits for the
// grouping (AGENTS.md rule 6), mono with tabular figures so columns align.
export function Money({ minor, currency = "INR", className = "" }: { minor: number; currency?: string; className?: string }) {
  return <span className={`font-mono tabular-nums ${className}`}>{formatMinorUnits(minor, currency)}</span>;
}
