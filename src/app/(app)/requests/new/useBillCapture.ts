"use client";

import { useEffect, useRef, useState } from "react";
import { checkDuplicateWarningAction, requestUploadSlot, runExtractionAction } from "./actions";
import { downscaleImage, sha256Hex } from "@/capture/imagePrep";
import { listDrafts, type QueuedAttachment } from "@/capture/draftQueue";
import type { Attachment } from "@/requests/captureCore";
import type { DuplicateMatch, DuplicateVerdict } from "@/duplicates/duplicateCore";

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
// Extraction is a live model call, not a background job — the capture
// screen awaits it synchronously (docs/START-HERE-slice-4.md finding #1),
// but never indefinitely: past this, proceed exactly as a failure would,
// straight to blank, editable fields.
const EXTRACTION_TIMEOUT_MS = 25_000;

// blob kept alongside every attachment (even after a successful upload) so
// that a LATER failure mid-multi-page-capture can still queue every page
// captured so far as one offline draft, uniformly — see the offline
// fallback in attachFile below.
export type PendingAttachment = Attachment & { previewUrl: string; blob: Blob };
export type FieldConfidence = Partial<Record<"vendor" | "amount" | "invoiceNo" | "invoiceDate" | "gstin", number>>;

// What extraction read off the first page, as plain strings ready to drop
// into the wizard's fields. Real extraction only — blank stays blank.
export type ExtractedFill = {
  vendor: string;
  amount: string;
  invoiceNo: string;
  invoiceDate: string;
  gstin: string;
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

const EXTRACTION_FAILED_NOTE = "Couldn't read this bill automatically — enter the details below.";

// Everything about getting the bill/quotation pages from the phone to R2 (or,
// failing signal, into the local offline queue), plus the extraction and the
// proactive duplicate note that ride on the first page. Behaviour is carried
// over unchanged from the single-page CaptureForm this wizard replaces.
export function useBillCapture({ onExtracted }: { onExtracted: (fill: ExtractedFill) => void }) {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [extractionNote, setExtractionNote] = useState<string | null>(null);
  const [extractionAttemptId, setExtractionAttemptId] = useState<string | null>(null);
  const [extractionPhash, setExtractionPhash] = useState<string | null>(null);
  const [fieldConfidence, setFieldConfidence] = useState<FieldConfidence>({});
  const [attachError, setAttachError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateMatch | null>(null);
  const [duplicateVerdict, setDuplicateVerdict] = useState<DuplicateVerdict | null>(null);
  // Offline capture (phase 14): once any attachment can't reach the
  // network, the whole capture falls back to being queued locally rather
  // than losing it — see attachFile's own fallback below.
  const [isOfflineCapture, setIsOfflineCapture] = useState(false);
  const [offlineQueue, setOfflineQueue] = useState<QueuedAttachment[]>([]);
  const [queuedDraftCount, setQueuedDraftCount] = useState(0);

  useEffect(() => {
    void listDrafts()
      .then((drafts) => setQueuedDraftCount(drafts.length))
      .catch(() => {});
  }, []);

  // Free the object URLs for the page thumbnails when the wizard goes away.
  const previewUrlsRef = useRef<string[]>([]);
  useEffect(() => {
    previewUrlsRef.current = attachments.map((a) => a.previewUrl);
  }, [attachments]);
  useEffect(() => {
    return () => {
      for (const url of previewUrlsRef.current) URL.revokeObjectURL(url);
    };
  }, []);

  function queueAttachmentsAsDraft(extra: QueuedAttachment) {
    setIsOfflineCapture(true);
    // Anything already uploaded this session moves back into the offline
    // queue too, keyed by the blob every attachment already carries — a
    // later connectivity drop shouldn't strand the pages that DID make it
    // out, it should just mean the whole capture is queued as one unit
    // (re-uploading an already-successful page is a little wasteful, not
    // incorrect: the orphaned R2 object never gets a request row).
    const alreadyUploaded = attachments.map((a) => ({ blob: a.blob, mime: a.mime, sha256: a.sha256, byteLength: a.byteLength }));
    setOfflineQueue((q) => [...q, ...alreadyUploaded, extra]);
    setAttachments([]);
  }

  async function attachFile(file: File, isImage: boolean) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setAttachError("That file is too large — try a smaller photo or PDF.");
      return;
    }

    const isFirstAttachment = attachments.length === 0 && offlineQueue.length === 0;

    setAttaching(true);
    setAttachError(null);
    try {
      const blob = isImage ? await downscaleImage(file) : file;
      const mime = isImage ? "image/jpeg" : "application/pdf";
      const sha256 = await sha256Hex(blob);

      if (isOfflineCapture || !navigator.onLine) {
        queueAttachmentsAsDraft({ blob, mime, sha256, byteLength: blob.size });
        return;
      }

      const slot = await requestUploadSlot(mime);
      if (!slot.ok) {
        setAttachError(slot.error);
        return;
      }

      const putResponse = await fetch(slot.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": mime },
        body: blob,
      }).catch(() => null);
      if (!putResponse || !putResponse.ok) {
        // A network failure, not a validation error — fall back to
        // queueing this and every earlier page in this session rather
        // than losing the capture.
        queueAttachmentsAsDraft({ blob, mime, sha256, byteLength: blob.size });
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
          blob,
        },
      ]);

      // Extraction and the proactive duplicate note both only ever look
      // at the first page — a multi-page bill's headline fields read off
      // page one, and re-running either for every subsequent page adds
      // nothing (see docs/START-HERE-slice-4.md).
      if (isFirstAttachment) {
        void checkDuplicateWarningAction(sha256)
          .then((result) => {
            setDuplicate(result.match);
            setDuplicateVerdict(result.verdict);
          })
          .catch(() => {});

        setExtracting(true);
        setExtractionNote(null);
        // A retaken first page must not carry the previous photo's
        // confidence badges or attempt into this one.
        setFieldConfidence({});
        setExtractionAttemptId(null);
        setExtractionPhash(null);
        try {
          const result = await withTimeout(runExtractionAction(slot.storageKey, mime), EXTRACTION_TIMEOUT_MS);
          if (result?.ok) {
            onExtracted({
              vendor: String(result.fields.vendor.value ?? ""),
              amount: result.fields.amount.value === null ? "" : String(result.fields.amount.value),
              invoiceNo: String(result.fields.invoiceNo.value ?? ""),
              invoiceDate: String(result.fields.invoiceDate.value ?? ""),
              gstin: String(result.fields.gstin.value ?? ""),
            });
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
            setExtractionNote(EXTRACTION_FAILED_NOTE);
            if (result?.ok === false) setExtractionAttemptId(result.attemptId);
          }
        } catch {
          setExtractionNote(EXTRACTION_FAILED_NOTE);
        } finally {
          setExtracting(false);
        }
      }
    } catch {
      setAttachError("Something went wrong attaching that file. Try again.");
    } finally {
      setAttaching(false);
    }
  }

  function removeAttachment(fileId: string) {
    setAttachments((prev) => {
      const gone = prev.find((a) => a.fileId === fileId);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return prev.filter((a) => a.fileId !== fileId);
    });
  }

  function removeOfflineAttachment(index: number) {
    // Nothing left queued means nothing left offline — the next page gets
    // a fresh try at the network.
    if (offlineQueue.length === 1) setIsOfflineCapture(false);
    setOfflineQueue((q) => q.filter((_, i) => i !== index));
  }

  return {
    attachments,
    offlineQueue,
    isOfflineCapture,
    attaching,
    extracting,
    extractionNote,
    extractionAttemptId,
    extractionPhash,
    fieldConfidence,
    attachError,
    clearAttachError: () => setAttachError(null),
    duplicate,
    duplicateVerdict,
    // A refused submit hands back the match and verdict it refused on; show
    // them the same way the proactive note is shown.
    applyDuplicate: (match: DuplicateMatch | null, verdict: DuplicateVerdict | null) => {
      setDuplicate(match);
      setDuplicateVerdict(verdict);
    },
    queuedDraftCount,
    attachFile,
    removeAttachment,
    removeOfflineAttachment,
  };
}
