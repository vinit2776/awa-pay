"use server";

import { headers } from "next/headers";
import { verifySession } from "@/auth/dal";
import { checkDuplicates, type DuplicateMatch, type DuplicateVerdict } from "@/duplicates/duplicateCore";
import { runExtraction, type RunExtractionResult } from "@/extraction/extractCore";
import { parseAmountToMinor } from "@/lib/money";
import { submitRequest as submitRequestCore, type Attachment } from "@/requests/captureCore";
import { mintUploadSlot, type UploadSlotResult } from "@/storage/uploadSlot";

async function getClientMeta(): Promise<{ ip: string; userAgent: string | undefined }> {
  const h = await headers();
  const forwardedFor = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwardedFor || h.get("x-real-ip") || "unknown";
  return { ip, userAgent: h.get("user-agent") ?? undefined };
}

export type { UploadSlotResult };

export async function requestUploadSlot(mime: string): Promise<UploadSlotResult> {
  await verifySession();
  return mintUploadSlot("bills", mime);
}

// Called by the capture screen the moment the first attachment finishes
// uploading — the client awaits this synchronously (with its own timeout)
// before showing the confirm step; see CaptureWizard.tsx. Never throws:
// runExtraction itself degrades an unconfigured key/API failure/malformed
// response to a recorded failed attempt, never a silent one.
export async function runExtractionAction(storageKey: string, mime: string): Promise<RunExtractionResult> {
  const session = await verifySession();
  return runExtraction(session.userId, storageKey, mime);
}

// The confirm screen's own proactive duplicate note (docs/START-HERE-
// slice-4.md finding #5) — the only signal available this early is the
// file checksum; vendor_key isn't resolved until account time.
export async function checkDuplicateWarningAction(
  checksum: string,
): Promise<{ verdict: DuplicateVerdict; match: DuplicateMatch | null }> {
  const session = await verifySession();
  return checkDuplicates(session.userId, "requester", { checksum });
}

export type SubmitFormState =
  | { ok: true; ref: string; requestId: string }
  | { ok: false; error: string; duplicate?: { match: DuplicateMatch; verdict: DuplicateVerdict } }
  | undefined;

export async function submitRequestAction(input: {
  departmentId: string;
  amount: string;
  invoiceNo: string;
  invoiceDate: string;
  vendor: string;
  gstinOnBill: string;
  note: string;
  kind?: "invoice" | "advance";
  // What the requester wants paid now, as typed. Empty means the whole amount.
  payNow?: string;
  payNowReason?: string;
  quotationNo?: string;
  invoiceExpectedBy?: string;
  attachments: Attachment[];
  linkedRequestId?: string | null;
  overrideDuplicateReason?: string;
  extraction?: { attemptId: string; phash: string | null };
}): Promise<SubmitFormState> {
  const session = await verifySession();
  const { ip, userAgent } = await getClientMeta();

  const amountMinor = parseAmountToMinor(input.amount);
  if (amountMinor === null) {
    return { ok: false, error: "Enter a valid amount." };
  }

  let payNowMinor: number | undefined;
  if (input.payNow) {
    const parsed = parseAmountToMinor(input.payNow);
    if (parsed === null) return { ok: false, error: "Enter a valid amount to pay now." };
    payNowMinor = parsed;
  }

  const result = await submitRequestCore({
    userId: session.userId,
    ip,
    userAgent,
    departmentId: input.departmentId,
    amountMinor,
    invoiceNo: input.invoiceNo || undefined,
    invoiceDate: input.invoiceDate || undefined,
    vendor: input.vendor || undefined,
    gstinOnBill: input.gstinOnBill || undefined,
    note: input.note || undefined,
    kind: input.kind,
    payNowMinor,
    payNowReason: input.payNowReason || undefined,
    quotationNo: input.quotationNo || undefined,
    invoiceExpectedBy: input.invoiceExpectedBy || undefined,
    attachments: input.attachments,
    linkedRequestId: input.linkedRequestId || undefined,
    overrideDuplicate: input.overrideDuplicateReason ? { reason: input.overrideDuplicateReason } : undefined,
    extraction: input.extraction,
  });

  if (!result.ok) {
    return { ok: false, error: result.error, duplicate: result.duplicate };
  }
  return { ok: true, ref: result.ref, requestId: result.requestId };
}
