"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { requestResubmitUploadSlot, resubmitAction } from "./actions";

async function sha256Hex(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function ResubmitForm({
  requestId,
  initialAmount,
  initialVendor,
  initialInvoiceNo,
  initialInvoiceDate,
  initialNote,
}: {
  requestId: string;
  initialAmount: string;
  initialVendor: string;
  initialInvoiceNo: string;
  initialInvoiceDate: string;
  initialNote: string;
}) {
  const router = useRouter();
  const [amount, setAmount] = useState(initialAmount);
  const [vendor, setVendor] = useState(initialVendor);
  const [invoiceNo, setInvoiceNo] = useState(initialInvoiceNo);
  const [invoiceDate, setInvoiceDate] = useState(initialInvoiceDate);
  const [note, setNote] = useState(initialNote);
  const [newAttachments, setNewAttachments] = useState<
    { fileId: string; storageKey: string; mime: string; byteLength: number; sha256: string }[]
  >([]);
  const [uploading, setUploading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function replaceBill(file: File) {
    setUploading(true);
    setError(null);
    try {
      const sha256 = await sha256Hex(file);
      const slot = await requestResubmitUploadSlot(file.type);
      if (!slot.ok) {
        setError(slot.error);
        return;
      }
      const putResponse = await fetch(slot.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
      if (!putResponse.ok) {
        setError("Upload failed.");
        return;
      }
      setNewAttachments((prev) => [...prev, { fileId: slot.fileId, storageKey: slot.storageKey, mime: file.type, byteLength: file.size, sha256 }]);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex w-full max-w-sm flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Replace the bill (optional)</span>
        <input
          type="file"
          accept="application/pdf,image/*"
          disabled={uploading}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void replaceBill(file);
          }}
        />
        {newAttachments.length > 0 && <span className="text-sm text-zinc-600 dark:text-zinc-400">new page attached</span>}
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Amount</span>
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-black"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Vendor</span>
        <input
          type="text"
          value={vendor}
          onChange={(e) => setVendor(e.target.value)}
          className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-black"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Invoice number</span>
        <input
          type="text"
          value={invoiceNo}
          onChange={(e) => setInvoiceNo(e.target.value)}
          className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-black"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Invoice date</span>
        <input
          type="date"
          value={invoiceDate}
          onChange={(e) => setInvoiceDate(e.target.value)}
          className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-black"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Explain what changed</span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-black"
        />
      </label>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <button
        type="button"
        disabled={pending || uploading}
        onClick={async () => {
          setPending(true);
          setError(null);
          const result = await resubmitAction(requestId, { amount, invoiceNo, invoiceDate, vendor, note, newAttachments });
          setPending(false);
          if (!result.ok) {
            setError(result.error);
            return;
          }
          router.push(`/requests/${requestId}`);
        }}
        className="rounded bg-black px-4 py-3 font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
      >
        {pending ? "Resubmitting…" : "Resubmit as new revision"}
      </button>
    </div>
  );
}
