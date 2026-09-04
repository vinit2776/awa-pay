"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { addVendorDocumentAction, requestVendorDocumentUploadSlot } from "./actions";
import type { vendorDocument } from "@/db/schema";

type DocumentKind = (typeof vendorDocument.$inferInsert)["kind"];

const KIND_OPTIONS: { value: DocumentKind; label: string }[] = [
  { value: "gst_certificate", label: "GST certificate" },
  { value: "pan_card", label: "PAN card" },
  { value: "udyam_certificate", label: "Udyam certificate" },
  { value: "cancelled_cheque", label: "Cancelled cheque" },
  { value: "other", label: "Other" },
];

async function sha256Hex(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function VendorDocumentUpload({ vendorId }: { vendorId: string }) {
  const router = useRouter();
  const [kind, setKind] = useState<DocumentKind>(KIND_OPTIONS[0].value);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setPending(true);
    setError(null);
    try {
      const sha256 = await sha256Hex(file);
      const slot = await requestVendorDocumentUploadSlot(file.type);
      if (!slot.ok) {
        setError(slot.error);
        return;
      }
      const putResponse = await fetch(slot.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
      if (!putResponse.ok) {
        setError("Upload failed.");
        return;
      }
      const result = await addVendorDocumentAction(vendorId, {
        kind,
        storageKey: slot.storageKey,
        mime: file.type,
        byteLength: file.size,
        sha256,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded border border-dashed border-zinc-300 p-3 dark:border-zinc-700">
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      <select value={kind} onChange={(e) => setKind(e.target.value as DocumentKind)} className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black">
        {KIND_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <input
        type="file"
        accept="image/jpeg,application/pdf"
        disabled={pending}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
          e.target.value = "";
        }}
        className="text-sm"
      />
    </div>
  );
}
