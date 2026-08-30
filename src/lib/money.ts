// Money is stored as integer minor units — paise, never floats, with the
// currency alongside (AGENTS.md rule 6). Indian digit grouping is a display
// concern, decided once, here.
export function formatMinorUnits(amountMinor: number, currency: string = "INR"): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(amountMinor / 100);
}
