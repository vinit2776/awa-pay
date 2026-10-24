"use client";

import { useRef } from "react";
import type { useBillCapture } from "./useBillCapture";
import type { Kind } from "./wizardTypes";
import { CameraIcon, ErrorLine, Spinner, StepTitle, secondaryButtonClass } from "./wizardUi";

type Capture = ReturnType<typeof useBillCapture>;

export function StepPhoto({ kind, capture, error }: { kind: Kind; capture: Capture; error: string | null }) {
  const photoInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const { attachments, offlineQueue, attaching, extracting } = capture;
  const hasPages = attachments.length > 0 || offlineQueue.length > 0;
  const busy = attaching || extracting;

  const title = kind === "invoice" ? "Take a photo of the bill" : "Take a photo of the quotation";
  const helper =
    kind === "invoice"
      ? "Keep it flat, in good light, and show the whole page."
      : "The paper with the price on it: quotation, proforma or work order.";

  return (
    <div className="flex flex-col gap-5">
      <StepTitle title={title} sub={helper} />

      {!hasPages && (
        <button
          type="button"
          disabled={busy}
          onClick={() => photoInputRef.current?.click()}
          className="flex min-h-[120px] w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-zinc-400 px-4 text-base font-semibold disabled:opacity-50 dark:border-zinc-600"
        >
          <CameraIcon />
          Take photo
        </button>
      )}

      <input
        ref={photoInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void capture.attachFile(file, true);
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
          if (file) void capture.attachFile(file, false);
        }}
      />

      {!hasPages && (
        <button
          type="button"
          disabled={busy}
          onClick={() => pdfInputRef.current?.click()}
          className="min-h-[54px] self-center px-2 text-base font-medium underline underline-offset-4 disabled:opacity-50"
        >
          Choose a PDF instead
        </button>
      )}

      {hasPages && (
        <ul className="flex flex-col gap-2">
          {attachments.map((a, i) => (
            <li
              key={a.fileId}
              className="flex min-h-[64px] items-center gap-3 rounded-lg border border-zinc-300 px-3 py-2 dark:border-zinc-700"
            >
              {a.mime === "application/pdf" ? (
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-zinc-100 text-sm font-semibold dark:bg-zinc-900">
                  PDF
                </span>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- a local blob: preview, not an optimisable remote image
                <img src={a.previewUrl} alt="" className="h-12 w-12 shrink-0 rounded object-cover" />
              )}
              <span className="flex-1 text-base font-medium">
                {a.mime === "application/pdf" ? "PDF added" : "Photo added"} — Page {i + 1}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  capture.removeAttachment(a.fileId);
                  (a.mime === "application/pdf" ? pdfInputRef : photoInputRef).current?.click();
                }}
                className="min-h-12 px-2 text-base font-medium underline underline-offset-4 disabled:opacity-50"
              >
                Retake
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => capture.removeAttachment(a.fileId)}
                className="min-h-12 px-2 text-base font-medium text-red-600 underline underline-offset-4 disabled:opacity-50 dark:text-red-400"
              >
                Remove
              </button>
            </li>
          ))}
          {offlineQueue.map((a, i) => (
            <li
              key={`offline-${i}`}
              className="flex min-h-[64px] items-center gap-3 rounded-lg border border-amber-400 bg-amber-50 px-3 py-2 dark:border-amber-800 dark:bg-amber-950"
            >
              <span className="flex-1 text-base font-medium">
                Page {attachments.length + i + 1} — {a.mime === "application/pdf" ? "PDF" : "photo"} saved on this phone
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => capture.removeOfflineAttachment(i)}
                className="min-h-12 px-2 text-base font-medium text-red-600 underline underline-offset-4 disabled:opacity-50 dark:text-red-400"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {hasPages && (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => photoInputRef.current?.click()} className={secondaryButtonClass}>
            + Add another page
          </button>
          <button type="button" disabled={busy} onClick={() => pdfInputRef.current?.click()} className={secondaryButtonClass}>
            + Add a PDF
          </button>
        </div>
      )}

      {attaching && (
        <p className="flex items-center gap-2 text-base text-zinc-600 dark:text-zinc-400" role="status">
          <Spinner /> Attaching…
        </p>
      )}
      {extracting && (
        <p className="flex items-center gap-2 text-base text-zinc-600 dark:text-zinc-400" role="status">
          <Spinner /> Reading the bill…
        </p>
      )}
      {capture.isOfflineCapture && (
        <p className="text-base text-amber-700 dark:text-amber-400">
          No connection — captured locally. It&apos;ll send itself once you&apos;re back on signal.
        </p>
      )}
      {capture.queuedDraftCount > 0 && (
        <p className="text-base text-zinc-600 dark:text-zinc-400">
          {capture.queuedDraftCount} draft{capture.queuedDraftCount === 1 ? "" : "s"} waiting to upload. They&apos;ll send themselves when
          you&apos;re back on signal.
        </p>
      )}
      <ErrorLine message={capture.attachError ?? error} />
    </div>
  );
}
