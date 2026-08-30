"use client";

import { useRef, useState } from "react";
import { requestUploadSlot, submitRequestAction } from "./actions";
import type { Attachment } from "@/requests/captureCore";

const MAX_DIMENSION = 2000;
const JPEG_QUALITY = 0.82;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

type PendingAttachment = Attachment & { previewUrl: string };

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

export function CaptureForm({ departments }: { departments: { id: string; name: string }[] }) {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [departmentId, setDepartmentId] = useState(departments[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [invoiceNo, setInvoiceNo] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [vendor, setVendor] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submittedRef, setSubmittedRef] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);

  async function attachFile(file: File, isImage: boolean) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setError("That file is too large — try a smaller photo or PDF.");
      return;
    }

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
    } catch {
      setError("Something went wrong attaching that file. Try again.");
    } finally {
      setAttaching(false);
    }
  }

  function removeAttachment(fileId: string) {
    setAttachments((prev) => prev.filter((a) => a.fileId !== fileId));
  }

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const result = await submitRequestAction({
        departmentId,
        amount,
        invoiceNo,
        invoiceDate,
        vendor,
        note,
        attachments: attachments.map((a) => ({
          fileId: a.fileId,
          storageKey: a.storageKey,
          mime: a.mime,
          byteLength: a.byteLength,
          sha256: a.sha256,
        })),
      });
      if (!result || !result.ok) {
        setError(result?.error ?? "Something went wrong. Try again.");
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
        <span className="text-sm font-medium">Amount</span>
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
        <span className="text-sm font-medium">Note (optional)</span>
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
        disabled={submitting || attaching || attachments.length === 0 || !departmentId}
        onClick={() => void handleSubmit()}
        className="rounded bg-black px-4 py-3 font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
      >
        {submitting ? "Submitting…" : "Submit"}
      </button>
    </div>
  );
}
