"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatMinorUnits, parseAmountToMinor } from "@/lib/money";
import { parseBankAccounts } from "@/lib/bankAccounts";
import type { PaymentMode } from "@/requests/transitions";
import type { PaymentBankReadiness } from "@/vendors/verifyCore";
import { payAction, returnToAccountsAction, requestAdviceUploadSlot, verifyVendorBankAction, insertVendorBankAsPayerAction } from "./actions";

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

export function PayerPanel({
  requestId,
  bankAccountsJson,
  readiness,
  suggestedAmountMinor,
  balanceMinor,
  currency,
  invoiceIsIn,
}: {
  requestId: string;
  bankAccountsJson: unknown;
  readiness: PaymentBankReadiness;
  // What to pay next (an advance's asked-for amount, a part-payment's first
  // part, or the balance) and the balance overall. The server enforces the
  // ceiling either way; these only save the payer from typing it wrong.
  suggestedAmountMinor: number;
  balanceMinor: number;
  currency: string;
  // False for an advance still waiting on its tax invoice: paying it can't
  // close the request, whatever the amount.
  invoiceIsIn: boolean;
}) {
  const router = useRouter();
  const accounts = parseBankAccounts(bankAccountsJson);
  const [mode, setMode] = useState<"pay" | "return">("pay");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [paymentMode, setPaymentMode] = useState<PaymentMode>("neft");
  const [valueDate, setValueDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState(() => (suggestedAmountMinor > 0 ? (suggestedAmountMinor / 100).toFixed(2) : ""));
  const [tds, setTds] = useState("0");
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [advice, setAdvice] = useState<{ fileId: string; storageKey: string; mime: string; byteLength: number; sha256: string } | null>(
    null,
  );
  const [uploading, setUploading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The self-correction path's own form state — reachable only from the
  // verify-first screen's fine print (docs/START-HERE-slice-3.md's design
  // decision on why: an escape hatch for the moment the payer is holding
  // fresh proof, not a general-purpose vendor-bank-edit surface).
  const [showCorrection, setShowCorrection] = useState(false);
  const [correctionBeneficiary, setCorrectionBeneficiary] = useState("");
  const [correctionAccount, setCorrectionAccount] = useState("");
  const [correctionIfsc, setCorrectionIfsc] = useState("");
  const [correctionBranch, setCorrectionBranch] = useState("");
  const [correctionEffectiveFrom, setCorrectionEffectiveFrom] = useState(() => new Date().toISOString().slice(0, 10));

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

  async function saveCorrection() {
    if (readiness.ready) return;
    const vendorId = readiness.reason === "no_bank" || readiness.reason === "unverified" ? readiness.vendorId : null;
    if (!vendorId) return;
    setPending(true);
    setError(null);
    const result = await insertVendorBankAsPayerAction(requestId, vendorId, {
      beneficiaryName: correctionBeneficiary,
      accountNumber: correctionAccount,
      ifsc: correctionIfsc,
      branch: correctionBranch || null,
      effectiveFrom: correctionEffectiveFrom,
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  // Say what the button will actually do: only a payment that clears the
  // balance once the invoice is in closes the request.
  const typedMinor = parseAmountToMinor(amount);
  const payLabel = !invoiceIsIn ? "Record advance payment" : typedMinor === balanceMinor ? "Mark paid & close" : "Record part payment";

  if (!readiness.ready) {
    return (
      <div className="flex flex-col gap-3 rounded border border-amber-400 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950">
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        {readiness.reason === "no_vendor" && (
          <p className="text-sm">This request has no accounted vendor — return it to accounts before paying.</p>
        )}

        {readiness.reason === "no_bank" && (
          <>
            <p className="text-sm">
              No bank details are on file for <strong>{readiness.vendorName}</strong>.{" "}
              <a href={`/vendors/${readiness.vendorId}`} target="_blank" rel="noreferrer" className="underline">
                Open the vendor record
              </a>{" "}
              to add them, or use the fine print below if you have proof in hand right now.
            </p>
          </>
        )}

        {readiness.reason === "unverified" && (
          <>
            <p className="text-sm font-medium">Verify this vendor&apos;s bank details before paying</p>
            <dl className="flex flex-col gap-1 text-sm">
              <div className="flex justify-between gap-2">
                <dt className="text-zinc-600 dark:text-zinc-400">Beneficiary</dt>
                <dd>{readiness.bank.beneficiaryName}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-zinc-600 dark:text-zinc-400">Account</dt>
                <dd className="font-mono">••••••{readiness.bank.accountNumberLast4}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-zinc-600 dark:text-zinc-400">IFSC</dt>
                <dd className="font-mono">{readiness.bank.ifsc}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-zinc-600 dark:text-zinc-400">Branch</dt>
                <dd>{readiness.bank.branch ?? "—"}</dd>
              </div>
            </dl>
            <p className="text-xs text-zinc-600 dark:text-zinc-400">Compare this against the bill before confirming.</p>
            <button
              type="button"
              disabled={pending}
              onClick={() => void run(() => verifyVendorBankAction(requestId, readiness.bank.id))}
              className="self-start rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
            >
              Matches the bill — verify
            </button>
          </>
        )}

        {(readiness.reason === "no_bank" || readiness.reason === "unverified") && (
          <div className="mt-2 border-t border-amber-300 pt-2 dark:border-amber-800">
            {showCorrection ? (
              <div className="flex flex-col gap-2">
                <p className="text-xs text-zinc-600 dark:text-zinc-400">
                  Only if you&apos;re holding proof right now — this is self-verified immediately and requires the vendor to already have
                  a document on file.
                </p>
                <input
                  type="text"
                  value={correctionBeneficiary}
                  onChange={(e) => setCorrectionBeneficiary(e.target.value)}
                  placeholder="Beneficiary name"
                  className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
                />
                <input
                  type="text"
                  inputMode="numeric"
                  value={correctionAccount}
                  onChange={(e) => setCorrectionAccount(e.target.value)}
                  placeholder="Account number"
                  className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
                />
                <input
                  type="text"
                  value={correctionIfsc}
                  onChange={(e) => setCorrectionIfsc(e.target.value)}
                  placeholder="IFSC"
                  className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
                />
                <input
                  type="text"
                  value={correctionBranch}
                  onChange={(e) => setCorrectionBranch(e.target.value)}
                  placeholder="Branch (optional)"
                  className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
                />
                <input
                  type="date"
                  value={correctionEffectiveFrom}
                  onChange={(e) => setCorrectionEffectiveFrom(e.target.value)}
                  className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={pending || !correctionBeneficiary.trim() || !correctionAccount.trim() || !correctionIfsc.trim()}
                    onClick={() => void saveCorrection()}
                    className="rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
                  >
                    Save — self-verified
                  </button>
                  <button type="button" onClick={() => setShowCorrection(false)} className="rounded border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setShowCorrection(true)} className="text-xs underline">
                I have different, verified bank details in hand
              </button>
            )}
          </div>
        )}
      </div>
    );
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
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            Balance still due: {formatMinorUnits(balanceMinor, currency)}. A payment can&apos;t take the total above what this request can settle.
          </p>
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
            {payLabel}
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
