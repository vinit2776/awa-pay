"use client";

import { useRef, useState } from "react";
import { checkDuplicateWarningAction, requestUploadSlot, runExtractionAction, submitRequestAction } from "./actions";
import type { Attachment } from "@/requests/captureCore";
import type { DuplicateMatch, DuplicateVerdict } from "@/duplicates/duplicateCore";

const MAX_DIMENSION = 2000;
const JPEG_QUALITY = 0.82;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
// Extraction is a live model call, not a background job — the capture
// screen awaits it synchronously (docs/START-HERE-slice-4.md finding #1),
// but never indefinitely: past this, proceed exactly as a failure would,
// straight to blank, editable fields.
const EXTRACTION_TIMEOUT_MS = 25_000;

type PendingAttachment = Attachment & { previewUrl: string };
type FieldConfidence = Partial<Record<"vendor" | "amount" | "invoiceNo" | "invoiceDate" | "gstin", number>>;

async function sha256Hex(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Downscales to at most MAX_DIMENSION on the longer edge (never upscales)
// and re-encodes as JPEG. This also drops EXIF and picks up the browser's
// EXIF auto-orientation on draw, so output comes out right-side-up.
async function downscaleImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas context unavailable.");
  ctx.drawImage(bitmap, 0, 0, width, height);

  return canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

function ConfidenceBadge({ confidence }: { confidence: number | undefined }) {
  if (confidence === undefined) return null;
  return confidence >= 0.8 ? (
    <span className="text-xs text-green-700 dark:text-green-400">✓ High confidence</span>
  ) : (
    <span className="text-xs text-amber-700 dark:text-amber-400">! Low confidence — please confirm</span>
  );
}

export function CaptureForm({
  departments,
  linkedRequestId,
  canOverrideDuplicate,
}: {
  departments: { id: string; name: string }[];
  linkedRequestId?: string | null;
  canOverrideDuplicate?: boolean;
}) {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [extractionNote, setExtractionNote] = useState<string | null>(null);
  const [extractionAttemptId, setExtractionAttemptId] = useState<string | null>(null);
  const [extractionPhash, setExtractionPhash] = useState<string | null>(null);
  const [fieldConfidence, setFieldConfidence] = useState<FieldConfidence>({});
  const [departmentId, setDepartmentId] = useState(departments[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [invoiceNo, setInvoiceNo] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [vendor, setVendor] = useState("");
  const [gstinOnBill, setGstinOnBill] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submittedRef, setSubmittedRef] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateMatch | null>(null);
  const [duplicateVerdict, setDuplicateVerdict] = useState<DuplicateVerdict | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  const photoInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);

  async function attachFile(file: File, isImage: boolean) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setError("That file is too large — try a smaller photo or PDF.");
      return;
    }

    const isFirstAttachment = attachments.length === 0;

    setAttaching(true);
    setError(null);
    try {
      const blob = isImage ? await downscaleImage(file) : file;
      const mime = isImage ? "image/jpeg" : "application/pdf";
      const sha256 = await sha256Hex(blob);

      const slot = await requestUploadSlot(mime);
      if (!slot.ok) {
        setError(slot.error);
        return;
      }

      const putResponse = await fetch(slot.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": mime },
        body: blob,
      });
      if (!putResponse.ok) {
        setError("Upload failed. Check your connection and try again.");
        return;
      }

      setAttachments((prev) => [
        ...prev,
        {
          fileId: slot.fileId,
          storageKey: slot.storageKey,
          mime,
          byteLength: blob.size,
          sha256,
          previewUrl: URL.createObjectURL(blob),
        },
      ]);

      // Extraction and the proactive duplicate note both only ever look
      // at the first page — a multi-page bill's headline fields read off
      // page one, and re-running either for every subsequent page adds
      // nothing (see docs/START-HERE-slice-4.md).
      if (isFirstAttachment) {
        void checkDuplicateWarningAction(sha256).then((result) => {
          setDuplicate(result.match);
          setDuplicateVerdict(result.verdict);
        });

        setExtracting(true);
        setExtractionNote(null);
        try {
          const result = await withTimeout(runExtractionAction(slot.storageKey, mime), EXTRACTION_TIMEOUT_MS);
          if (result?.ok) {
            setVendor(String(result.fields.vendor.value ?? ""));
            setAmount(result.fields.amount.value === null ? "" : String(result.fields.amount.value));
            setInvoiceNo(String(result.fields.invoiceNo.value ?? ""));
            setInvoiceDate(String(result.fields.invoiceDate.value ?? ""));
            setGstinOnBill(String(result.fields.gstin.value ?? ""));
            setFieldConfidence({
              vendor: result.fields.vendor.confidence,
              amount: result.fields.amount.confidence,
              invoiceNo: result.fields.invoiceNo.confidence,
              invoiceDate: result.fields.invoiceDate.confidence,
              gstin: result.fields.gstin.confidence,
            });
            setExtractionAttemptId(result.attemptId);
            setExtractionPhash(result.phash);
          } else {
            // A failure degrades to blank, editable fields, never to
            // silence (AGENTS.md) — the fields are already blank; this is
            // the visible part.
            setExtractionNote("Couldn't read this bill automatically — enter the details below.");
            if (result?.ok === false) setExtractionAttemptId(result.attemptId);
          }
        } finally {
          setExtracting(false);
        }
      }
    } catch {
      setError("Something went wrong attaching that file. Try again.");
    } finally {
      setAttaching(false);
    }
  }

  function removeAttachment(fileId: string) {
    setAttachments((prev) => prev.filter((a) => a.fileId !== fileId));
  }

  async function handleSubmit(overrideDuplicateReason?: string) {
    setSubmitting(true);
    setError(null);
    try {
      const result = await submitRequestAction({
        departmentId,
        amount,
        invoiceNo,
        invoiceDate,
        vendor,
        gstinOnBill,
        note,
        attachments: attachments.map((a) => ({
          fileId: a.fileId,
          storageKey: a.storageKey,
          mime: a.mime,
          byteLength: a.byteLength,
          sha256: a.sha256,
        })),
        linkedRequestId,
        overrideDuplicateReason,
        extraction: extractionAttemptId ? { attemptId: extractionAttemptId, phash: extractionPhash } : undefined,
      });
      if (!result || !result.ok) {
        setError(result?.error ?? "Something went wrong. Try again.");
        setDuplicate(result?.duplicate?.match ?? null);
        return;
      }
      setSubmittedRef(result.ref);
    } finally {
      setSubmitting(false);
    }
  }

  if (submittedRef) {
    return (
      <div className="flex w-full max-w-sm flex-col items-center gap-3 text-center">
        <p className="text-lg font-semibold">Submitted — {submittedRef}</p>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Your approver will pick this up from their queue.
        </p>
      </div>
    );
  }

  return (
    <div className="flex w-full max-w-sm flex-col gap-5">
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Bill</span>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={attaching}
            onClick={() => photoInputRef.current?.click()}
            className="flex-1 rounded border border-zinc-300 px-3 py-3 text-sm font-medium disabled:opacity-50 dark:border-zinc-700"
          >
            Photograph the bill
          </button>
          <button
            type="button"
            disabled={attaching}
            onClick={() => pdfInputRef.current?.click()}
            className="flex-1 rounded border border-zinc-300 px-3 py-3 text-sm font-medium disabled:opacity-50 dark:border-zinc-700"
          >
            Choose PDF
          </button>
        </div>
        <input
          ref={photoInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void attachFile(file, true);
          }}
        />
        <input
          ref={pdfInputRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void attachFile(file, false);
          }}
        />
        {attaching && <p className="text-sm text-zinc-500">Attaching…</p>}
        {extracting && <p className="text-sm text-zinc-500">Reading the bill…</p>}
        {extractionNote && <p className="text-sm text-amber-700 dark:text-amber-400">{extractionNote}</p>}
        {attachments.length > 0 && (
          <ul className="flex flex-col gap-1">
            {attachments.map((a, i) => (
              <li key={a.fileId} className="flex items-center justify-between rounded bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-900">
                <span>Page {i + 1} — {a.mime === "application/pdf" ? "PDF" : "photo"}</span>
                <button type="button" onClick={() => removeAttachment(a.fileId)} className="text-red-600 dark:text-red-400">
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Department</span>
        <select
          value={departmentId}
          onChange={(e) => setDepartmentId(e.target.value)}
          className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-black"
        >
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="flex items-center justify-between text-sm font-medium">
          Amount <ConfidenceBadge confidence={fieldConfidence.amount} />
        </span>
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-black"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="flex items-center justify-between text-sm font-medium">
          Vendor <ConfidenceBadge confidence={fieldConfidence.vendor} />
        </span>
        <input
          type="text"
          value={vendor}
          onChange={(e) => setVendor(e.target.value)}
          className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-black"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="flex items-center justify-between text-sm font-medium">
          Invoice number <ConfidenceBadge confidence={fieldConfidence.invoiceNo} />
        </span>
        <input
          type="text"
          value={invoiceNo}
          onChange={(e) => setInvoiceNo(e.target.value)}
          className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-black"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="flex items-center justify-between text-sm font-medium">
          Invoice date <ConfidenceBadge confidence={fieldConfidence.invoiceDate} />
        </span>
        <input
          type="date"
          value={invoiceDate}
          onChange={(e) => setInvoiceDate(e.target.value)}
          className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-black"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="flex items-center justify-between text-sm font-medium">
          GSTIN on bill <ConfidenceBadge confidence={fieldConfidence.gstin} />
        </span>
        <input
          type="text"
          value={gstinOnBill}
          onChange={(e) => setGstinOnBill(e.target.value)}
          className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-black"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Note (optional)</span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-black"
        />
      </label>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {duplicate && duplicateVerdict === "warned_open" && (
        <div className="rounded border border-amber-400 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
          <p className="font-medium">Seen this before?</p>
          <p>
            A byte-identical file was already raised on a request in stage &quot;{duplicate.stage}&quot;
            {duplicate.invoiceDate && <> · invoiced {duplicate.invoiceDate}</>}. Worth a quick check before submitting.
          </p>
        </div>
      )}

      {duplicate && duplicateVerdict === "blocked_paid" && (
        <div className="flex flex-col gap-2 rounded border border-red-400 bg-red-50 p-3 text-sm dark:border-red-800 dark:bg-red-950">
          <p className="font-medium">This looks like a duplicate of an already-paid bill.</p>
          {duplicate.viewableByActor ? (
            <p>
              Matches request in stage &quot;{duplicate.stage}&quot;{duplicate.reference && <> · UTR {duplicate.reference}</>}
              {duplicate.invoiceDate && <> · invoiced {duplicate.invoiceDate}</>}.
            </p>
          ) : (
            <p>Matches a request in a department you can&apos;t see{duplicate.viewerHint && <> — {duplicate.viewerHint}</>}.</p>
          )}
          {canOverrideDuplicate && (
            <div className="flex flex-col gap-2 border-t border-red-300 pt-2 dark:border-red-800">
              <textarea
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                placeholder="Reason for overriding this match"
                rows={2}
                className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
              />
              <button
                type="button"
                disabled={submitting || !overrideReason.trim()}
                onClick={() => void handleSubmit(overrideReason)}
                className="self-start rounded border border-red-500 px-3 py-2 text-sm font-medium text-red-700 disabled:opacity-50 dark:text-red-300"
              >
                Override and submit anyway
              </button>
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        disabled={submitting || attaching || extracting || attachments.length === 0 || !departmentId}
        onClick={() => void handleSubmit()}
        className="rounded bg-black px-4 py-3 font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
      >
        {submitting ? "Submitting…" : "Submit"}
      </button>
    </div>
  );
}
