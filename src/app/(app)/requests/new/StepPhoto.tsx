"use client";

import { useRef } from "react";
import type { useBillCapture } from "./useBillCapture";
import type { Kind } from "./wizardTypes";
import { Callout, CameraIcon, ErrorLine, Spinner, StepTitle, dangerLinkClass, linkButtonClass, secondaryButtonClass } from "./wizardUi";

type Capture = ReturnType<typeof useBillCapture>;

export function StepPhoto({ kind, capture, error }: { kind: Kind; capture: Capture; error: string | null }) {
  const photoInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const { attachments, offlineQueue, attaching, extracting } = capture;
  const hasPages = attachments.length > 0 || offlineQueue.length > 0;
  const busy = attaching || extracting;
  const paper = kind === "invoice" ? "bill" : "quotation";

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
          className="flex min-h-[160px] w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-line bg-surface px-4 text-base font-semibold text-ink transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-45"
        >
          <span className="text-accent">
            <CameraIcon />
          </span>
          {attaching ? "Attaching…" : "Take photo"}
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
        <button type="button" disabled={busy} onClick={() => pdfInputRef.current?.click()} className={`${linkButtonClass} self-center`}>
          Choose a PDF instead
        </button>
      )}

      {hasPages && (
        <ul className="flex flex-col gap-2">
          {attachments.map((a, i) => (
            <li key={a.fileId} className="flex min-h-[64px] items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2">
              {a.mime === "application/pdf" ? (
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-sunk font-mono text-sm font-semibold text-ink-2">PDF</span>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- a local blob: preview, not an optimisable remote image
                <img src={a.previewUrl} alt="" className="h-12 w-12 shrink-0 rounded-md border border-line-soft object-cover" />
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
                className={linkButtonClass}
              >
                Retake
              </button>
              <button type="button" disabled={busy} onClick={() => capture.removeAttachment(a.fileId)} className={dangerLinkClass}>
                Remove
              </button>
            </li>
          ))}
          {offlineQueue.map((a, i) => (
            <li key={`offline-${i}`} className="flex min-h-[64px] items-center gap-3 rounded-xl border border-warn-line bg-warn-soft px-3 py-2">
              <span className="flex-1 text-base font-medium">
                Page {attachments.length + i + 1} — {a.mime === "application/pdf" ? "PDF" : "photo"} saved on this phone
              </span>
              <button type="button" disabled={busy} onClick={() => capture.removeOfflineAttachment(i)} className={dangerLinkClass}>
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

      {attaching && hasPages && (
        <p className="flex items-center gap-2 text-base text-ink-2" role="status">
          <Spinner /> Attaching…
        </p>
      )}
      {extracting && (
        <div className="flex flex-col gap-3 rounded-xl border border-line-soft bg-surface p-3">
          <p className="flex items-center gap-2 text-base text-ink-2" role="status">
            <Spinner /> Reading the {paper}… usually under 10 seconds
          </p>
          <button type="button" onClick={capture.skipReading} className={secondaryButtonClass}>
            Skip — I&apos;ll type the details
          </button>
        </div>
      )}
      {capture.isOfflineCapture && (
        <Callout tone="warn" title="You're offline">
          This is saved on this phone. It&apos;ll send itself once you&apos;re back on signal.
        </Callout>
      )}
      {capture.queuedDraftCount > 0 && (
        <Callout tone="info">
          {capture.queuedDraftCount} request{capture.queuedDraftCount === 1 ? "" : "s"} saved on this phone, waiting to send. They&apos;ll go
          on their own once you&apos;re back on signal.
        </Callout>
      )}
      <ErrorLine message={capture.attachError ?? error} />
    </div>
  );
}
