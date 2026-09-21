import { pgEnum } from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("role", [
  "requester",
  "approver",
  "accountant",
  "payer",
  "super_admin",
  "developer",
]);

export const deptScopeEnum = pgEnum("dept_scope", ["global", "list"]);

export const companyScopeEnum = pgEnum("company_scope", ["global", "list", "n/a"]);

export const userStatusEnum = pgEnum("user_status", ["active", "disabled"]);

export const requestStageEnum = pgEnum("request_stage", [
  "raised",
  "awaiting_approval",
  "with_accounts",
  "to_pay",
  "paid",
  "on_hold",
  "rejected",
  "withdrawn",
  "awaiting_invoice",
]);

// invoice: a tax invoice exists on day one. advance: only a quotation,
// proforma or work order exists, money goes out first and the tax invoice
// is collected afterwards (concept-v2.html section 09).
export const requestKindEnum = pgEnum("request_kind", ["invoice", "advance"]);

export const paymentModeEnum = pgEnum("payment_mode", ["neft", "rtgs", "imps", "upi", "cheque", "other"]);

export const holdSubReasonEnum = pgEnum("hold_sub_reason", [
  "short_supply",
  "damaged",
  "quality_rejected",
  "rate_dispute",
  "awaiting_credit_note",
  "service_not_rendered",
]);

export const requestFileKindEnum = pgEnum("request_file_kind", ["bill", "payment_advice", "comment_attachment"]);

export const vendorDocumentKindEnum = pgEnum("vendor_document_kind", [
  "gst_certificate",
  "pan_card",
  "udyam_certificate",
  "cancelled_cheque",
  "other",
]);

// "matched_advance" is deliberately excluded — it only makes sense once a
// request can be part-paid (docs/concept-v2.html §09), out of scope for
// this slice. Five of the brief's six verdicts, matching §08 exactly:
// paid -> hard block, open -> warn, rejected -> escalate, held -> link,
// nothing -> silent (represented here as "none").
export const duplicateVerdictEnum = pgEnum("duplicate_verdict", [
  "blocked_paid",
  "warned_open",
  "escalated_rejected",
  "linked_held",
  "none",
]);

// The six fields the confirmation screen shows (concept-v2.html §02/§15).
// currency is included for the audit table's own completeness even though
// it's never actually asked of the model — an India-only system, always
// "INR" — see src/extraction/extractCore.ts.
export const extractionFieldEnum = pgEnum("extraction_field", [
  "vendor",
  "amount",
  "currency",
  "invoiceNo",
  "invoiceDate",
  "gstin",
]);

export const extractionAttemptStatusEnum = pgEnum("extraction_attempt_status", ["succeeded", "failed"]);
