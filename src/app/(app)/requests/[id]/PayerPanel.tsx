"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { parseAmountToMinor } from "@/lib/money";
import { parseBankAccounts } from "@/lib/bankAccounts";
import type { PaymentMode } from "@/requests/transitions";
import { payAction, returnToAccountsAction, requestAdviceUploadSlot } from "./actions";

const MODES: { value: PaymentMode; label: string }[] = [
  { value: "neft", label: "NEFT" },
  { value: "rtgs", label: "RTGS" },
  { value: "imps", label: "IMPS" },
  { value: "upi", label: "UPI" },
  { value: "cheque", label: "Cheque" },
  { value: "other", label: "Other" },
];

async function sha256Hex(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function PayerPanel({ requestId, bankAccountsJson }: { requestId: string; bankAccountsJson: unknown }) {
  const router = useRouter();
  const accounts = parseBankAccounts(bankAccountsJson);
  const [mode, setMode] = useState<"pay" | "return">("pay");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [paymentMode, setPaymentMode] = useState<PaymentMode>("neft");
  const [valueDate, setValueDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState("");
  const [tds, setTds] = useState("0");
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [advice, setAdvice] = useState<{ fileId: string; storageKey: string; mime: string; byteLength: number; sha256: string } | null>(
    null,
  );
  const [uploading, setUploading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setPending(true);
    setError(null);
    const result = await action();
    setPending(false);
    if (!result.ok) {
      setError(result.error ?? "Something went wrong.");
      return;
    }
    router.refresh();
  }

  async function attachAdvice(file: File) {
    setUploading(true);
    setError(null);
    try {
      const sha256 = await sha256Hex(file);
      const slot = await requestAdviceUploadSlot(file.type);
      if (!slot.ok) {
        setError(slot.error);
        return;
      }
      const putResponse = await fetch(slot.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
      if (!putResponse.ok) {
        setError("Upload failed.");
        return;
      }
      setAdvice({ fileId: slot.fileId, storageKey: slot.storageKey, mime: file.type, byteLength: file.size, sha256 });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded border border-zinc-300 p-4 dark:border-zinc-700">
      <div className="flex gap-2 text-sm">
        <button type="button" onClick={() => setMode("pay")} className={mode === "pay" ? "font-semibold underline" : ""}>
          Record payment
        </button>
        <button type="button" onClick={() => setMode("return")} className={mode === "return" ? "font-semibold underline" : ""}>
          Return to accounts
        </button>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {mode === "pay" ? (
        <>
          {accounts.length === 0 ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              No bank accounts on file for this company yet.
            </p>
          ) : (
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label} — {a.bankName}
                </option>
              ))}
            </select>
          )}
          <select
            value={paymentMode}
            onChange={(e) => setPaymentMode(e.target.value as PaymentMode)}
            className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
          >
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={valueDate}
            onChange={(e) => setValueDate(e.target.value)}
            className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
          />
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Amount paid"
            className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
          />
          <input
            type="text"
            inputMode="decimal"
            value={tds}
            onChange={(e) => setTds(e.target.value)}
            placeholder="TDS deducted"
            className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
          />
          <input
            type="text"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="UTR / reference — required"
            className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
          />
          <label className="text-sm">
            <span className="mr-2">Payment advice (optional):</span>
            <input
              type="file"
              accept="application/pdf,image/*"
              disabled={uploading}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void attachAdvice(file);
              }}
            />
            {advice && <span className="ml-2 text-zinc-600 dark:text-zinc-400">attached</span>}
          </label>
          <button
            type="button"
            disabled={pending || uploading || !reference.trim() || !accountId}
            onClick={() => {
              const account = accounts.find((a) => a.id === accountId);
              const amountMinor = parseAmountToMinor(amount);
              const tdsMinor = parseAmountToMinor(tds) ?? 0;
              if (!account || amountMinor === null) {
                setError("Enter a valid amount.");
                return;
              }
              void run(() =>
                payAction(requestId, {
                  fromAccount: account,
                  mode: paymentMode,
                  valueDate,
                  amountMinor,
                  tdsMinor,
                  reference,
                  advice: advice ?? undefined,
                }),
              );
            }}
            className="rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
          >
            Mark paid &amp; close
          </button>
        </>
      ) : (
        <>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason for sending back to accounts"
            rows={2}
            className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
          />
          <button
            type="button"
            disabled={pending || !reason.trim()}
            onClick={() => void run(() => returnToAccountsAction(requestId, { reason }))}
            className="rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
          >
            Return to accounts
          </button>
        </>
      )}
    </div>
  );
}
