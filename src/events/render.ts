import { formatMinorUnits } from "@/lib/money";

// Pure — no DB, no next/headers — directly Vitest-testable against fixed
// fixtures. Produces the brief's one-line trail format ("Approved ·
// Sunita Desai · 07 Aug 09:05 · cycle set to on-or-before 14 Aug"). Actor
// name isn't on the event row itself (event.actor is just a user id), so
// callers resolve it via a join and pass it in — this function stays pure.

export type RenderableEvent = {
  type: string;
  after: unknown;
};

export type EventSummary = { icon: string; label: string; detail: string };

const HOLD_SUB_REASON_LABELS: Record<string, string> = {
  short_supply: "short supply",
  damaged: "damaged",
  quality_rejected: "quality rejected",
  rate_dispute: "rate dispute",
  awaiting_credit_note: "awaiting credit note",
  service_not_rendered: "service not rendered",
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function renderEventSummary(event: RenderableEvent): EventSummary {
  const after = asRecord(event.after);
  const str = (key: string): string => (typeof after[key] === "string" ? (after[key] as string) : "");
  const num = (key: string): number | null => (typeof after[key] === "number" ? (after[key] as number) : null);

  switch (event.type) {
    case "request.raised": {
      const fileCount = num("fileCount") ?? 0;
      const duplicateVerdict = str("duplicateVerdict");
      const linkedRequestId = str("linkedRequestId");
      const parts = [`${fileCount} file${fileCount === 1 ? "" : "s"} attached`];
      if (linkedRequestId) parts.push("reconsideration of a rejected request");
      if (duplicateVerdict && duplicateVerdict !== "none") parts.push(`duplicate check: ${duplicateVerdict.replace(/_/g, " ")}`);
      const extractionSummary = typeof after.extraction === "object" && after.extraction !== null ? (after.extraction as Record<string, unknown>) : null;
      if (extractionSummary) {
        if (extractionSummary.escalated) parts.push("extraction escalated to sonnet");
        const fieldsCorrected = typeof extractionSummary.fieldsCorrected === "number" ? extractionSummary.fieldsCorrected : 0;
        if (fieldsCorrected > 0) parts.push(`${fieldsCorrected} field${fieldsCorrected === 1 ? "" : "s"} corrected`);
      }
      return { icon: "✓", label: "Raised", detail: parts.join(" · ") };
    }
    case "request.approved": {
      const cycle = str("cycle");
      const dueDate = str("dueDate");
      const detail =
        cycle === "dated" && dueDate
          ? `cycle set to on or before ${dueDate}`
          : cycle === "immediate"
            ? "cycle set to immediate"
            : "cycle left to payer's discretion";
      return { icon: "✓", label: "Approved", detail };
    }
    case "request.returned":
      return { icon: "!", label: "Returned for correction", detail: str("reason") };
    case "request.held": {
      const subReason = HOLD_SUB_REASON_LABELS[str("subReason")] ?? str("subReason");
      const reviewOn = str("reviewOn");
      return { icon: "!", label: "Held", detail: `${subReason} · review on ${reviewOn} · ${str("reason")}` };
    }
    case "request.hold_released":
      return { icon: "✓", label: "Hold released", detail: "back with the approver" };
    case "request.rejected":
      return { icon: "✕", label: "Rejected", detail: str("reason") };
    case "request.accounted":
      return { icon: "✓", label: "Accounted", detail: `voucher ${str("voucherNo")} · booked ${str("bookedOn")}` };
    case "request.returned_to_approver":
      return { icon: "!", label: "Returned to approver", detail: str("reason") };
    case "request.paid": {
      const amountMinor = num("amountMinor");
      const amount = amountMinor !== null ? formatMinorUnits(amountMinor) : "";
      return { icon: "₹", label: "Paid", detail: `${str("mode").toUpperCase()} · ${amount} · UTR ${str("reference")}` };
    }
    case "request.returned_to_accounts":
      return { icon: "!", label: "Returned to accounts", detail: str("reason") };
    case "request.resubmitted":
      return { icon: "✓", label: "Resubmitted", detail: `revision ${num("revision") ?? ""}` };
    case "request.withdrawn":
      return { icon: "✕", label: "Withdrawn", detail: "" };
    case "request.query_raised": {
      const directedAt = Array.isArray(after.directedAt) ? (after.directedAt as string[]).join(" and ") : "";
      return { icon: "?", label: `Query to ${directedAt}`, detail: str("question") };
    }
    case "request.query_answered":
      return { icon: "✓", label: "Query answered", detail: str("answer") };
    case "request.nudged":
      return { icon: "◔", label: "Nudged", detail: `${str("toRole")} · "any update?"` };
    case "vendor.created": {
      const gstin = str("gstin");
      return { icon: "✓", label: "Vendor created", detail: gstin ? `${str("name")} · ${gstin}` : str("name") };
    }
    case "vendor.bank_verified":
      return { icon: "✓", label: "Vendor bank verified", detail: `${str("ifsc")} · ••••${str("accountNumberLast4")}` };
    default:
      return { icon: "·", label: event.type, detail: "" };
  }
}
