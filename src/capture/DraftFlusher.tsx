"use client";

import { useEffect } from "react";
import { requestUploadSlot, submitRequestAction } from "@/app/(app)/requests/new/actions";
import type { Attachment } from "@/requests/captureCore";
import { flushDrafts, type QueuedDraft } from "./draftQueue";

// Mounted once in the (app) layout, not just the capture page — a queued
// draft should flush the next time the app is opened at all, not only
// when the requester happens to navigate back to /requests/new
// specifically. Foreground-retry-on-open (mount + the `online` event) is
// the complete mechanism for both platforms this slice — true background
// sync (no open tab required) needs upload logic running inside the
// service worker itself, which can't call Next's Server Actions the way
// page code can; a real, separate undertaking, deliberately deferred
// rather than half-built as a listener that doesn't actually do anything
// (docs/START-HERE-slice-4.md).

async function uploadDraft(draft: QueuedDraft): Promise<boolean> {
  try {
    const attachments: Attachment[] = [];
    for (const a of draft.attachments) {
      const slot = await requestUploadSlot(a.mime);
      if (!slot.ok) return false;
      const putResponse = await fetch(slot.uploadUrl, { method: "PUT", headers: { "Content-Type": a.mime }, body: a.blob });
      if (!putResponse.ok) return false;
      attachments.push({ fileId: slot.fileId, storageKey: slot.storageKey, mime: a.mime, byteLength: a.byteLength, sha256: a.sha256 });
    }

    const result = await submitRequestAction({
      departmentId: draft.departmentId,
      amount: draft.amount,
      invoiceNo: draft.invoiceNo,
      invoiceDate: draft.invoiceDate,
      vendor: draft.vendor,
      gstinOnBill: draft.gstinOnBill,
      note: draft.note,
      kind: draft.kind ?? "invoice",
      payNow: draft.payNow,
      payNowReason: draft.payNowReason,
      quotationNo: draft.quotationNo,
      invoiceExpectedBy: draft.invoiceExpectedBy,
      attachments,
    });
    return Boolean(result?.ok);
  } catch {
    return false;
  }
}

export function DraftFlusher() {
  useEffect(() => {
    function attemptFlush() {
      void flushDrafts(uploadDraft);
    }
    attemptFlush();
    window.addEventListener("online", attemptFlush);
    return () => window.removeEventListener("online", attemptFlush);
  }, []);

  return null;
}
