import { eq } from "drizzle-orm";
import { type ScopedTx, withGrantScope } from "@/db/runtime";
import { extraction, extractionAttempt } from "@/db/schema";
import { getObjectBytes } from "@/storage/r2";
import { CONFIDENCE_FLOORS, DECISIVE_FIELDS } from "./confidenceFloors";
import { HAIKU_MODEL, SONNET_MODEL, callModel } from "./client";
import { computeDHash } from "./dhash";
import type { ExtractedFields } from "./schema";

// Pure orchestration, no next/headers — mirrors duplicateCore.ts's shape.
// The one place tier-1/tier-2 escalation is decided, and the one place an
// extraction_attempt row gets written — always, success or failure, since
// that row is what makes abandonment measurable at all (an attempt whose
// request_id never gets backfilled by submitRequest is exactly what
// "abandoned" means here). Never throws: an unconfigured key, an R2
// fetch failure, or two failed model calls all resolve to a recorded
// failed attempt and a null fields result — the caller (the capture
// screen's server action) degrades to blank, editable fields either way,
// per AGENTS.md's own rule that a failure is never silent.

export type RunExtractionResult =
  | { ok: true; attemptId: string; fields: ExtractedFields; model: string; escalated: boolean; phash: string | null }
  | { ok: false; attemptId: string; error: string };

export function needsEscalation(fields: ExtractedFields): boolean {
  return DECISIVE_FIELDS.some((field) => fields[field].confidence < CONFIDENCE_FLOORS[field]);
}

export async function runExtraction(actorId: string, storageKey: string, mime: string): Promise<RunExtractionResult> {
  let bytes: Buffer;
  try {
    bytes = await getObjectBytes(storageKey);
  } catch (err) {
    return recordFailure(actorId, storageKey, err instanceof Error ? err.message : "Could not read the uploaded file.");
  }

  const base64 = bytes.toString("base64");

  let fields: ExtractedFields;
  let model = HAIKU_MODEL;
  let escalated = false;
  try {
    fields = await callModel(HAIKU_MODEL, base64, mime);
    if (needsEscalation(fields)) {
      fields = await callModel(SONNET_MODEL, base64, mime);
      model = SONNET_MODEL;
      escalated = true;
    }
  } catch (tier1Err) {
    // "or the call errors" (AGENTS.md) — give the second tier a chance
    // before giving up entirely.
    try {
      fields = await callModel(SONNET_MODEL, base64, mime);
      model = SONNET_MODEL;
      escalated = true;
    } catch (tier2Err) {
      const message = tier2Err instanceof Error ? tier2Err.message : tier1Err instanceof Error ? tier1Err.message : "Extraction failed.";
      return recordFailure(actorId, storageKey, message);
    }
  }

  // image/jpeg only — PDFs are skipped, an accepted limitation (see
  // docs/START-HERE-slice-4.md). Reuses the same bytes already fetched
  // for the vision call, no second R2 GET.
  const phash = mime === "image/jpeg" ? await computeDHash(bytes).catch(() => null) : null;

  const attemptId = await withGrantScope(actorId, "requester", async (tx) => {
    const [attempt] = await tx
      .insert(extractionAttempt)
      .values({ storageKey, attemptedBy: actorId, status: "succeeded", model, escalated })
      .returning({ id: extractionAttempt.id });

    await tx.insert(extraction).values([
      { attemptId: attempt.id, field: "vendor", value: strOf(fields.vendor.value), confidence: fields.vendor.confidence },
      { attemptId: attempt.id, field: "amount", value: strOf(fields.amount.value), confidence: fields.amount.confidence },
      { attemptId: attempt.id, field: "invoiceNo", value: strOf(fields.invoiceNo.value), confidence: fields.invoiceNo.confidence },
      { attemptId: attempt.id, field: "invoiceDate", value: strOf(fields.invoiceDate.value), confidence: fields.invoiceDate.confidence },
      { attemptId: attempt.id, field: "gstin", value: strOf(fields.gstin.value), confidence: fields.gstin.confidence },
      // Never asked of the model — always "INR" in this India-only
      // system — stored anyway so the per-field audit table matches the
      // brief's own six-field shape (concept-v2.html §15) uniformly.
      { attemptId: attempt.id, field: "currency", value: "INR", confidence: 1 },
    ]);

    return attempt.id;
  });

  return { ok: true, attemptId, fields, model, escalated, phash };
}

function strOf(value: string | number | null): string | null {
  return value === null ? null : String(value);
}

async function recordFailure(actorId: string, storageKey: string, error: string): Promise<RunExtractionResult> {
  const attemptId = await withGrantScope(actorId, "requester", async (tx) => {
    const [attempt] = await tx
      .insert(extractionAttempt)
      .values({ storageKey, attemptedBy: actorId, status: "failed", error })
      .returning({ id: extractionAttempt.id });
    return attempt.id;
  });
  return { ok: false, attemptId, error };
}

// Called by submitRequest, inside its own transaction, only for whichever
// attempt actually gets submitted — backfills request_id and fills in
// accepted_value/corrected_by by diffing the final submitted values
// against what's already stored here. Never re-queries the model. Returns
// a compact summary for request.raised's own after payload — the full
// per-field detail lives in the extraction table itself (the health
// console and reports' actual source), not duplicated into event jsonb;
// same "summary in the event, full detail in its own table" split
// duplicateCheck already established for duplicateVerdict.
export async function attachExtractionToRequest(
  tx: ScopedTx,
  attemptId: string,
  requestId: string,
  actorId: string,
  finalValues: { vendor: string | null; amountMajor: number | null; invoiceNo: string | null; invoiceDate: string | null; gstin: string | null },
): Promise<{ model: string | null; escalated: boolean; fieldsCorrected: number }> {
  const [attempt] = await tx
    .update(extractionAttempt)
    .set({ requestId })
    .where(eq(extractionAttempt.id, attemptId))
    .returning({ model: extractionAttempt.model, escalated: extractionAttempt.escalated });

  const rows = await tx.select().from(extraction).where(eq(extraction.attemptId, attemptId));
  const finalByField: Record<string, string | null> = {
    vendor: finalValues.vendor,
    amount: finalValues.amountMajor === null ? null : String(finalValues.amountMajor),
    invoiceNo: finalValues.invoiceNo,
    invoiceDate: finalValues.invoiceDate,
    gstin: finalValues.gstin,
    currency: "INR",
  };

  let fieldsCorrected = 0;
  for (const row of rows) {
    const acceptedValue = finalByField[row.field] ?? null;
    const correctedBy = acceptedValue !== row.value ? actorId : null;
    if (correctedBy) fieldsCorrected += 1;
    await tx.update(extraction).set({ acceptedValue, correctedBy }).where(eq(extraction.id, row.id));
  }

  return { model: attempt?.model ?? null, escalated: attempt?.escalated ?? false, fieldsCorrected };
}
