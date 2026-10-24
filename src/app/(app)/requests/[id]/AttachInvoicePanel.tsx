"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { downscaleImage, sha256Hex } from "@/capture/imagePrep";
import { formatMinorUnits, parseAmountToMinor } from "@/lib/money";
import { attachInvoiceAction, requestInvoiceUploadSlot } from "./actions";

const MAX_BYTES = 15 * 1024 * 1024;

type UploadedPage = { fileId: string; storageKey: string; mime: string; byteLength: number; sha256: string };

// The second half of an advance. Shown to the requester who raised it, once
// the advance has been paid and the request is waiting on the vendor's tax
// invoice. Same plain-language, big-target style as the raise wizard: this
// is the same low-tech person, weeks later.
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

  const inputClass = "min-h-12 rounded border border-zinc-300 px-3 py-2 text-base dark:border-zinc-700 dark:bg-black";
  const labelClass = "text-base font-medium";

  return (
    <div className="flex flex-col gap-3 rounded border border-violet-400 bg-violet-50 p-4 dark:border-violet-700 dark:bg-violet-950">
      <div>
        <h2 className="text-lg font-semibold">Attach the final bill</h2>
        <p className="text-sm text-zinc-700 dark:text-zinc-300">
          The advance of {formatMinorUnits(paidMinor, currency)} has been paid. When {vendor ?? "the vendor"}&apos;s tax invoice arrives, add it here and the
          balance goes to be paid.
          {expectedBy && <> You said it would come around {expectedBy}.</>}
        </p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <label className="flex flex-col gap-1">
        <span className={labelClass}>Invoice number</span>
        <input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} className={inputClass} />
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Invoice date</span>
        <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} className={inputClass} />
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Total on the invoice</span>
        <input inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} className={inputClass} />
        <span className="text-xs text-zinc-600 dark:text-zinc-400">
          The final amount, with tax. Quoted: {formatMinorUnits(quotedMinor, currency)}.
          {balanceMinor !== null && balanceMinor >= 0 && <> Balance to pay after the advance: {formatMinorUnits(balanceMinor, currency)}.</>}
        </span>
      </label>

      <div className="flex flex-col gap-2">
        <span className={labelClass}>Photo or PDF of the invoice</span>
        {pages.length > 0 && (
          <p className="text-sm text-green-700 dark:text-green-400">
            {pages.length} page{pages.length === 1 ? "" : "s"} added
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
          className="min-h-12 rounded border border-zinc-400 px-4 py-2 text-base disabled:opacity-50 dark:border-zinc-600"
        >
          {uploading ? "Uploading…" : pages.length === 0 ? "Add photo or PDF" : "Add another page"}
        </button>
      </div>

      <button
        type="button"
        disabled={pending || uploading}
        onClick={() => void submit()}
        className="min-h-14 rounded bg-black px-4 py-3 text-base font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
      >
        {pending ? "Attaching…" : "Attach invoice"}
      </button>
    </div>
  );
}
