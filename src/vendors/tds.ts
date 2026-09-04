// A static reference table, not vendor-editable data — TDS sections and
// rates are law, not a vendor attribute. Display/reference only: it labels
// a vendor's stored tds_section (vendor.ts) for the accounts desk, but
// never silently computes payment.tds_minor — that stays a manual,
// editable field (see payment.ts's own header comment on why). Not
// exhaustive; the four sections here are the ones a bill-payment system
// like this one is most likely to hit (contractors, professional/
// technical services, rent, commission). Extend as new vendor types
// appear.
export const TDS_SECTIONS: Record<string, { label: string; ratePercent: number }> = {
  "194C": { label: "194C · Contractors", ratePercent: 2 },
  "194J": { label: "194J · Professional/technical services", ratePercent: 10 },
  "194I": { label: "194I · Rent", ratePercent: 10 },
  "194H": { label: "194H · Commission/brokerage", ratePercent: 5 },
};

export function tdsRateLabel(section: string | null | undefined): string | null {
  if (!section) return null;
  const known = TDS_SECTIONS[section];
  return known ? `${known.label} · ${known.ratePercent}%` : section;
}
