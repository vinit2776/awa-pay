"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { checkDuplicateWarningAction, requestUploadSlot, runExtractionAction, submitRequestAction } from "./actions";
import { downscaleImage, sha256Hex } from "@/capture/imagePrep";
import { enqueueDraft, listDrafts, type QueuedAttachment } from "@/capture/draftQueue";
import { isLowConfidence, unconfirmedFields, type ExtractedField, type FieldConfidence } from "@/capture/confirmFields";
import type { Attachment } from "@/requests/captureCore";
import type { DuplicateMatch, DuplicateVerdict } from "@/duplicates/duplicateCore";
import { Notice } from "@/ui/Notice";
import { StageTrack } from "@/ui/StageTrack";
import { buttonClass, eyebrowClass, inputClass, labelClass } from "@/ui/styles";

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
type PendingAttachment = Attachment & { previewUrl: string; blob: Blob };

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

const FIELD_LABEL: Record<ExtractedField, string> = {
  amount: "Amount",
  vendor: "Vendor",
  invoiceNo: "Invoice no.",
  invoiceDate: "Invoice date",
  gstin: "GSTIN on bill",
};

// "Raise another" remounts the form with a new key rather than resetting
// every piece of state by hand — nothing from the last bill can leak in.
export function RaiseFlow(props: { departments: { id: string; name: string }[]; linkedRequestId?: string | null; canOverrideDuplicate?: boolean }) {
  const [round, setRound] = useState(0);
  return <CaptureForm key={round} {...props} onRaiseAnother={() => setRound((r) => r + 1)} />;
}

function Steps({ current }: { current: 1 | 2 }) {
  const steps = ["Bill", "Details", "Send"];
  return (
    <ol className="flex items-center gap-1.5 text-[11.5px] text-ink-3" aria-label={`Step ${current} of 3`}>
      {steps.map((label, i) => {
        const n = i + 1;
        const done = n < current;
        const cur = n === current;
        return (
          <li key={label} className="flex flex-1 items-center gap-1.5 last:flex-none">
            <span className={`flex items-center gap-1.5 ${cur ? "font-semibold text-ink" : ""}`} aria-current={cur ? "step" : undefined}>
              <span
                className={`grid size-[18px] place-items-center rounded-full border-[1.5px] text-[10px] font-semibold ${
                  done ? "border-accent bg-accent text-accent-ink" : cur ? "border-accent text-accent" : "border-line"
                }`}
              >
                {done ? "✓" : n}
              </span>
              {label}
            </span>
            {n < steps.length && <span className="h-px min-w-2 flex-1 bg-line" />}
          </li>
        );
      })}
    </ol>
  );
}

export function CaptureForm({
  departments,
  linkedRequestId,
  canOverrideDuplicate,
  onRaiseAnother,
}: {
  departments: { id: string; name: string }[];
  linkedRequestId?: string | null;
  canOverrideDuplicate?: boolean;
  onRaiseAnother?: () => void;
}) {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [extractionNote, setExtractionNote] = useState<string | null>(null);
  const [extractionAttemptId, setExtractionAttemptId] = useState<string | null>(null);
  const [extractionPhash, setExtractionPhash] = useState<string | null>(null);
  const [fieldConfidence, setFieldConfidence] = useState<FieldConfidence>({});
  const [confirmed, setConfirmed] = useState<Set<ExtractedField>>(new Set());
  const [showGstin, setShowGstin] = useState(false);
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
  // Offline capture (phase 14): once any attachment can't reach the
  // network, the whole capture falls back to being queued locally rather
  // than losing it — see attachFile's own fallback below.
  const [isOfflineCapture, setIsOfflineCapture] = useState(false);
  const [offlineQueue, setOfflineQueue] = useState<QueuedAttachment[]>([]);
  const [queuedDraftCount, setQueuedDraftCount] = useState(0);
  const [justQueued, setJustQueued] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  // "Skip — I'll type the details": the requester stops waiting on the
  // model. A reading that lands afterwards must not overwrite what they've
  // typed; its attempt id is still kept so the model's answer and the
  // human's values can be compared, exactly as when the reading succeeds.
  const skippedRef = useRef(false);

  useEffect(() => {
    void listDrafts().then((drafts) => setQueuedDraftCount(drafts.length));
  }, []);

  function queueAttachmentsAsDraft(extra: QueuedAttachment) {
    setIsOfflineCapture(true);
    // Anything already uploaded this session moves back into the offline
    // queue too, keyed by the blob every attachment already carries — a
    // later connectivity drop shouldn't strand the pages that DID make it
    // out, it should just mean the whole capture is queued as one unit
    // (re-uploading an already-successful page is a little wasteful, not
    // incorrect: the orphaned R2 object never gets a request row).
    setAttachments((prev) => {
      if (prev.length > 0) {
        setOfflineQueue((q) => [
          ...q,
          ...prev.map((a) => ({ blob: a.blob, mime: a.mime, sha256: a.sha256, byteLength: a.byteLength })),
        ]);
      }
      return [];
    });
    setOfflineQueue((q) => [...q, extra]);
  }

  async function attachFile(file: File, isImage: boolean) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setError("That file is too large — try a smaller photo or PDF.");
      return;
    }

    const isFirstAttachment = attachments.length === 0 && offlineQueue.length === 0;

    setAttaching(true);
    setError(null);
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
        setError(slot.error);
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
        void checkDuplicateWarningAction(sha256).then((result) => {
          setDuplicate(result.match);
          setDuplicateVerdict(result.verdict);
        });

        skippedRef.current = false;
        setExtracting(true);
        setExtractionNote(null);
        try {
          const result = await withTimeout(runExtractionAction(slot.storageKey, mime), EXTRACTION_TIMEOUT_MS);
          if (skippedRef.current) {
            if (result) setExtractionAttemptId(result.attemptId);
            if (result?.ok) setExtractionPhash(result.phash);
          } else if (result?.ok) {
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

  function skipReading() {
    skippedRef.current = true;
    setExtracting(false);
  }

  // Editing a field is confirming it — the requester has looked at it.
  function edit(field: ExtractedField, set: (v: string) => void) {
    return (value: string) => {
      set(value);
      setConfirmed((prev) => (prev.has(field) ? prev : new Set(prev).add(field)));
    };
  }

  function confirm(field: ExtractedField) {
    setConfirmed((prev) => new Set(prev).add(field));
  }

  async function handleSubmit(overrideDuplicateReason?: string) {
    setSubmitting(true);
    setError(null);
    try {
      // Offline this whole capture, or connectivity dropped partway
      // through — queue locally rather than attempt a submit that has
      // nothing real to point at yet (no attachments actually reached
      // R2). The draft flushes itself the next time the app opens with a
      // connection (src/capture/DraftFlusher.tsx).
      if (isOfflineCapture || (attachments.length === 0 && offlineQueue.length > 0)) {
        await enqueueDraft({ departmentId, amount, invoiceNo, invoiceDate, vendor, gstinOnBill, note, attachments: offlineQueue });
        setJustQueued(true);
        return;
      }

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

  const fileInputs = (
    <>
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
    </>
  );

  // ---- Sent / saved ----

  if (submittedRef) {
    return (
      <div className="flex flex-col gap-5 pt-6">
        <span className="grid size-13 place-items-center rounded-full bg-accent-soft text-2xl text-accent" aria-hidden>
          ✓
        </span>
        <div className="flex flex-col gap-1">
          <span className={eyebrowClass}>Sent to your approver</span>
          <p className="font-mono text-2xl font-medium">{submittedRef}</p>
          {vendor && <p className="text-sm text-ink-2">{vendor}</p>}
        </div>
        <StageTrack stage="awaiting_approval" />
        <p className="text-sm text-ink-2">
          An approver in your department will pick this up. You&apos;ll hear from us if they ask a question or send it back.
        </p>
        <div className="flex flex-col gap-2">
          <button type="button" onClick={onRaiseAnother} className={buttonClass("primary", "md", true)}>
            Raise another
          </button>
          <Link href="/requests" className={buttonClass("secondary", "md", true)}>
            See my requests
          </Link>
        </div>
      </div>
    );
  }

  if (justQueued) {
    return (
      <div className="flex flex-col gap-5 pt-6">
        <Notice tone="warn" title="Saved on this phone">
          No connection right now. This bill will send itself next time the app is open with signal.
        </Notice>
        <div className="flex flex-col gap-2">
          <button type="button" onClick={onRaiseAnother} className={buttonClass("primary", "md", true)}>
            Raise another
          </button>
          <Link href="/requests" className={buttonClass("secondary", "md", true)}>
            See my requests
          </Link>
        </div>
      </div>
    );
  }

  // ---- Step 1: capture ----

  const hasPages = attachments.length > 0 || offlineQueue.length > 0;

  if (!hasPages) {
    return (
      <div className="flex flex-col gap-4">
        {fileInputs}
        <Steps current={1} />
        <button
          type="button"
          disabled={attaching}
          onClick={() => photoInputRef.current?.click()}
          className="flex min-h-72 flex-col items-center justify-center gap-2.5 rounded-2xl border-[1.5px] border-dashed border-line bg-surface p-6 text-center transition-colors hover:border-accent disabled:opacity-60"
        >
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="text-accent" aria-hidden>
            <path d="M4 8h3l2-3h6l2 3h3v11H4z" strokeLinejoin="round" />
            <circle cx="12" cy="13" r="3.5" />
          </svg>
          <span className="text-base font-semibold">{attaching ? "Attaching…" : "Photograph the bill"}</span>
          <span className="max-w-[24ch] text-[13px] text-ink-2">Lay it flat and fill the frame. You can add more pages next.</span>
        </button>
        <button type="button" disabled={attaching} onClick={() => photoInputRef.current?.click()} className={buttonClass("primary", "md", true)}>
          Open camera
        </button>
        <button type="button" disabled={attaching} onClick={() => pdfInputRef.current?.click()} className={buttonClass("secondary", "md", true)}>
          Upload a PDF instead
        </button>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {queuedDraftCount > 0 && (
          <Notice tone="info" title={`${queuedDraftCount} bill${queuedDraftCount === 1 ? "" : "s"} waiting to send`}>
            Saved on this phone while offline. They&apos;ll send on their own once you have signal.
          </Notice>
        )}
      </div>
    );
  }

  // ---- Step 2: check details ----

  const firstPage = attachments[0];
  const unconfirmed = unconfirmedFields(fieldConfidence, confirmed);
  const blockedPaid = duplicate && duplicateVerdict === "blocked_paid";

  function field(name: ExtractedField, input: ReactNode) {
    const low = isLowConfidence(name, fieldConfidence[name]);
    const needsTap = low && !confirmed.has(name);
    const read = fieldConfidence[name] !== undefined;
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={`capture-${name}`} className={labelClass}>
            {FIELD_LABEL[name]}
          </label>
          {read &&
            (needsTap ? (
              <span className="text-[11px] font-semibold text-warn">! Check against the bill</span>
            ) : (
              <span className="text-[11px] font-semibold text-ok">✓ {low ? "Confirmed" : "Read from bill"}</span>
            ))}
        </div>
        <div className="flex gap-2">
          <div className={`flex-1 ${needsTap ? "[&>input]:border-warn-line [&>input]:bg-warn-soft" : ""}`}>{input}</div>
          {needsTap && (
            <button type="button" onClick={() => confirm(name)} className={buttonClass("secondary", "sm")}>
              Looks right
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {fileInputs}
      <Steps current={2} />

      <div className="flex flex-col gap-2">
        {firstPage && firstPage.mime !== "application/pdf" ? (
          // eslint-disable-next-line @next/next/no-img-element -- a local blob: URL, not a remote image
          <img src={firstPage.previewUrl} alt="Page 1 of the bill" className="max-h-64 w-full rounded-lg border border-line bg-surface object-contain" />
        ) : (
          <div className="grid h-28 place-items-center rounded-lg border border-line bg-surface text-sm text-ink-2">
            {firstPage ? "PDF attached" : "Saved on this phone"}
          </div>
        )}
        <ul className="flex flex-wrap items-center gap-2" aria-label="Pages">
          {attachments.map((a, i) => (
            <li key={a.fileId} className="flex items-center gap-1 rounded-md border border-line bg-surface py-1 pr-1 pl-2 text-xs text-ink-2">
              Page {i + 1}
              <button
                type="button"
                onClick={() => removeAttachment(a.fileId)}
                aria-label={`Remove page ${i + 1}`}
                className="grid size-5 place-items-center rounded text-ink-3 hover:bg-danger-soft hover:text-danger"
              >
                ×
              </button>
            </li>
          ))}
          {offlineQueue.map((_, i) => (
            <li key={`offline-${i}`} className="rounded-md border border-warn-line bg-warn-soft px-2 py-1 text-xs text-warn">
              Page {attachments.length + i + 1} · on phone
            </li>
          ))}
          <li>
            <button type="button" disabled={attaching} onClick={() => photoInputRef.current?.click()} className={buttonClass("ghost", "sm")}>
              {attaching ? "Attaching…" : "+ Add a page"}
            </button>
          </li>
        </ul>
      </div>

      {isOfflineCapture && (
        <Notice tone="warn" title="You're offline">
          The bill is saved on this phone. Fill in what you can — it sends on its own once you&apos;re back on signal.
        </Notice>
      )}

      {extracting ? (
        <div className="flex flex-col gap-3 rounded-lg border border-line-soft bg-surface p-4">
          <p className="flex items-center gap-2.5 text-sm text-ink-2" role="status">
            <span className="size-4 animate-spin rounded-full border-2 border-accent border-r-transparent motion-reduce:animate-none" aria-hidden />
            Reading the bill… usually under 10 seconds
          </p>
          <button type="button" onClick={skipReading} className={buttonClass("secondary", "md", true)}>
            Skip — I&apos;ll type the details
          </button>
        </div>
      ) : (
        <>
          {extractionNote && <Notice tone="warn" title="Couldn't read this bill">Enter the details below.</Notice>}

          {duplicate && duplicateVerdict === "warned_open" && (
            <Notice tone="warn" title="Seen this bill before?">
              The same file is already on a request that is {duplicate.stage.replaceAll("_", " ")}
              {duplicate.invoiceDate && <>, invoiced {duplicate.invoiceDate}</>}. Check you&apos;re not raising it twice.
            </Notice>
          )}

          {blockedPaid && (
            <Notice tone="danger" title="Already paid">
              {duplicate.viewableByActor ? (
                <>
                  This bill matches a request that is {duplicate.stage.replaceAll("_", " ")}
                  {duplicate.reference && <>, UTR <span className="font-mono">{duplicate.reference}</span></>}
                  {duplicate.invoiceDate && <>, invoiced {duplicate.invoiceDate}</>}. It can&apos;t be raised again.
                </>
              ) : (
                <>It matches a request in a department you can&apos;t see{duplicate.viewerHint && <> — {duplicate.viewerHint}</>}.</>
              )}
              {canOverrideDuplicate && (
                <div className="mt-2 flex flex-col gap-2 border-t border-danger-line pt-2">
                  <label htmlFor="capture-override" className={labelClass}>
                    Super admin override — reason
                  </label>
                  <textarea id="capture-override" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} rows={2} className={inputClass} />
                  <button
                    type="button"
                    disabled={submitting || !overrideReason.trim()}
                    onClick={() => void handleSubmit(overrideReason)}
                    className={`${buttonClass("danger", "sm")} self-start`}
                  >
                    Override and send
                  </button>
                </div>
              )}
            </Notice>
          )}

          {field(
            "amount",
            <div className="relative">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 font-mono text-ink-3">₹</span>
              <input
                id="capture-amount"
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => edit("amount", setAmount)(e.target.value)}
                placeholder="0.00"
                className={`${inputClass} pl-7 font-mono text-lg tabular-nums`}
              />
            </div>,
          )}
          {field("vendor", <input id="capture-vendor" type="text" value={vendor} onChange={(e) => edit("vendor", setVendor)(e.target.value)} className={inputClass} />)}
          <div className="grid grid-cols-1 gap-4 min-[360px]:grid-cols-2">
            {field(
              "invoiceNo",
              <input id="capture-invoiceNo" type="text" value={invoiceNo} onChange={(e) => edit("invoiceNo", setInvoiceNo)(e.target.value)} className={`${inputClass} font-mono`} />,
            )}
            {field(
              "invoiceDate",
              <input id="capture-invoiceDate" type="date" value={invoiceDate} onChange={(e) => edit("invoiceDate", setInvoiceDate)(e.target.value)} className={`${inputClass} font-mono`} />,
            )}
          </div>

          {showGstin || gstinOnBill || isLowConfidence("gstin", fieldConfidence.gstin) ? (
            field(
              "gstin",
              <input id="capture-gstin" type="text" value={gstinOnBill} onChange={(e) => edit("gstin", setGstinOnBill)(e.target.value)} className={`${inputClass} font-mono uppercase`} />,
            )
          ) : (
            <button type="button" onClick={() => setShowGstin(true)} className={`${buttonClass("ghost", "sm")} self-start`}>
              + GSTIN on bill
            </button>
          )}

          <div className="flex flex-col gap-1">
            <label htmlFor="capture-department" className={labelClass}>
              Department
            </label>
            {departments.length === 1 ? (
              <p id="capture-department" className="text-sm">
                {departments[0].name}
              </p>
            ) : (
              <select id="capture-department" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className={inputClass}>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="capture-note" className={labelClass}>
              Note for the approver <span className="font-normal text-ink-3">optional</span>
            </label>
            <textarea id="capture-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} className={inputClass} />
          </div>

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          <div className="flex flex-col gap-1.5">
            {unconfirmed.length > 0 && (
              <p className="text-[12.5px] text-warn">
                Check {unconfirmed.map((f) => FIELD_LABEL[f].toLowerCase()).join(", ")} against the bill, then tap &ldquo;Looks right&rdquo;.
              </p>
            )}
            <button
              type="button"
              disabled={submitting || attaching || !departmentId || unconfirmed.length > 0 || !!blockedPaid}
              onClick={() => void handleSubmit()}
              className={buttonClass("primary", "md", true)}
            >
              {submitting ? "Sending…" : isOfflineCapture ? "Save to send later" : "Send to approver"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
