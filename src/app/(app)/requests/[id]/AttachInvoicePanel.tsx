"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { downscaleImage, sha256Hex } from "@/capture/imagePrep";
import { formatMinorUnits, parseAmountToMinor } from "@/lib/money";
import { attachInvoiceAction, requestInvoiceUploadSlot } from "./actions";

const MAX_BYTES = 15 * 1024 * 1024;

type UploadedPage = { fileId: string; storageKey: string; mime: string; byteLength: number; sha256: string };

// Same sizes as the raise wizard (src/app/(app)/requests/new/wizardUi.tsx):
// this is the same low-tech requester, weeks later, so 48px inputs, 54px
// buttons and 16px text rather than the desk screens' density.
const inputClass =
  "min-h-12 w-full rounded-lg border border-line bg-surface px-3 py-2 text-base text-ink focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-accent-soft";
const labelClass = "text-base font-medium";
const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

// The second half of an advance. Shown to the requester who raised it, once
// the advance has been paid and the request is waiting on the vendor's tax
// invoice.
export function AttachInvoicePanel({
  requestId,
  vendor,
  currency,
  quotedMinor,
  paidMinor,
  expectedBy,
}: {
  requestId: string;
  vendor: string | null;
  currency: string;
  quotedMinor: number;
  paidMinor: number;
  expectedBy: string | null;
}) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [invoiceNo, setInvoiceNo] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [total, setTotal] = useState((quotedMinor / 100).toFixed(2));
  const [pages, setPages] = useState<UploadedPage[]>([]);
  const [uploading, setUploading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totalMinor = parseAmountToMinor(total.replace(/,/g, ""));
  const balanceMinor = totalMinor === null ? null : totalMinor - paidMinor;

  async function addPage(file: File) {
    if (file.size > MAX_BYTES) {
      setError("That file is too large — try a smaller photo or PDF.");
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const isImage = file.type.startsWith("image/");
      const blob = isImage ? await downscaleImage(file) : file;
      const mime = isImage ? "image/jpeg" : "application/pdf";
      const slot = await requestInvoiceUploadSlot(mime);
      if (!slot.ok) {
        setError(slot.error);
        return;
      }
      const put = await fetch(slot.uploadUrl, { method: "PUT", headers: { "Content-Type": mime }, body: blob }).catch(() => null);
      if (!put || !put.ok) {
        setError("The upload didn't go through. Check your connection and try again.");
        return;
      }
      const sha256 = await sha256Hex(blob);
      setPages((prev) => [...prev, { fileId: slot.fileId, storageKey: slot.storageKey, mime, byteLength: blob.size, sha256 }]);
    } finally {
      setUploading(false);
    }
  }

  async function submit() {
    setError(null);
    if (!invoiceNo.trim()) return setError("Enter the invoice number.");
    if (!invoiceDate) return setError("Enter the invoice date.");
    if (totalMinor === null) return setError("Enter the total on the invoice.");
    if (pages.length === 0) return setError("Add a photo or PDF of the invoice.");
    if (balanceMinor !== null && balanceMinor < 0) {
      return setError(`That is less than the ${formatMinorUnits(paidMinor, currency)} already paid as an advance. Tell accounts before attaching it.`);
    }

    setPending(true);
    const result = await attachInvoiceAction(requestId, { invoiceNo: invoiceNo.trim(), invoiceDate, amountMinor: totalMinor, attachments: pages });
    setPending(false);
    if (!result.ok) return setError(result.error);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-warn-line bg-surface p-4 shadow-[inset_3px_0_0_var(--warn)]">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">Attach the final bill</h2>
        <p className="text-base text-ink-2">
          The advance of <span className="font-mono">{formatMinorUnits(paidMinor, currency)}</span> has been paid. When {vendor ?? "the vendor"}
          &apos;s tax invoice arrives, add it here and the balance goes to be paid.
          {expectedBy && <> You said it would come around {expectedBy}.</>}
        </p>
      </div>

      {error && (
        <p role="alert" className="text-base text-danger">
          {error}
        </p>
      )}

      <label className="flex flex-col gap-1.5">
        <span className={labelClass}>Invoice number</span>
        <input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} className={`${inputClass} font-mono`} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={labelClass}>Invoice date</span>
        <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} className={`${inputClass} font-mono`} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={labelClass}>Total on the invoice</span>
        <input inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} className={`${inputClass} font-mono tabular-nums`} />
        <span className="text-base text-ink-2">
          The final amount, with tax. Quoted: <span className="font-mono">{formatMinorUnits(quotedMinor, currency)}</span>.
          {balanceMinor !== null && balanceMinor >= 0 && (
            <>
              {" "}
              Balance to pay after the advance: <span className="font-mono">{formatMinorUnits(balanceMinor, currency)}</span>.
            </>
          )}
        </span>
      </label>

      <div className="flex flex-col gap-2">
        <span className={labelClass}>Photo or PDF of the invoice</span>
        {pages.length > 0 && (
          <p className="text-base font-medium text-ok">
            ✓ {pages.length} page{pages.length === 1 ? "" : "s"} added
          </p>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,application/pdf"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void addPage(file);
          }}
        />
        <button
          type="button"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
          className={`min-h-[54px] rounded-lg border border-line bg-surface px-4 text-base font-medium text-ink hover:bg-sunk disabled:opacity-45 ${focusRing}`}
        >
          {uploading ? "Uploading…" : pages.length === 0 ? "Add photo or PDF" : "Add another page"}
        </button>
      </div>

      <button
        type="button"
        disabled={pending || uploading}
        onClick={() => void submit()}
        className={`min-h-[54px] rounded-lg bg-accent px-4 text-base font-semibold text-accent-ink hover:bg-accent/90 disabled:opacity-45 ${focusRing}`}
      >
        {pending ? "Attaching…" : "Attach invoice"}
      </button>
    </div>
  );
}
