import { parseAmountToMinor } from "@/lib/money";

// Requesters type amounts the way they read them: "3,36,000", sometimes with
// a rupee sign. parseAmountToMinor rejects commas by design, so strip the
// grouping and any currency mark here, at the edge of the wizard.
export function cleanAmount(input: string): string {
  return input.replace(/[,\s]/g, "").replace(/^₹/, "");
}

export function amountToMinor(input: string): number | null {
  return parseAmountToMinor(cleanAmount(input));
}

// Integer paise back to the plain decimal string the server action expects
// ("336000.00"). Integer arithmetic only — no float rupees.
export function minorToPlain(minor: number): string {
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
}

// Percentage of a total in integer minor units.
export function percentOfMinor(totalMinor: number, pct: number): number {
  return Math.round((totalMinor * pct) / 100);
}

// Local calendar date N days from now as YYYY-MM-DD.
export function isoDateInDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}
