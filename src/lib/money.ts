// Money is stored as integer minor units — paise, never floats, with the
// currency alongside (AGENTS.md rule 6). Indian digit grouping is a display
// concern, decided once, here.
export function formatMinorUnits(amountMinor: number, currency: string = "INR"): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(amountMinor / 100);
}

// The inverse, for form input. String-split rather than
// `Math.round(parseFloat(x) * 100)` — float multiplication is precision-
// unsafe (19.99 * 100 is 1998.9999999999998 in JS). Returns null for
// anything that isn't a positive amount with at most 2 fractional digits.
export function parseAmountToMinor(input: string): number | null {
  const trimmed = input.trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) return null;

  const [, rupees, fraction = ""] = match;
  const paise = fraction.padEnd(2, "0");
  const amountMinor = Number(rupees) * 100 + Number(paise);

  return amountMinor > 0 ? amountMinor : null;
}
