"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatMinorUnits, parseAmountToMinor } from "@/lib/money";
import { parseBankAccounts } from "@/lib/bankAccounts";
import { buttonClass, inputClass, labelClass } from "@/ui/styles";
import { Notice } from "@/ui/Notice";
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
  billAmountMinor,
  suggestedAmountMinor,
  balanceMinor,
  currency,
  invoiceIsIn,
}: {
  requestId: string;
  bankAccountsJson: unknown;
  readiness: PaymentBankReadiness;
  billAmountMinor: number;
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
  const [returning, setReturning] = useState(false);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [paymentMode, setPaymentMode] = useState<PaymentMode>("neft");
  const [valueDate, setValueDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState(() => (suggestedAmountMinor > 0 ? (suggestedAmountMinor / 100).toFixed(2) : ""));
  const [tds, setTds] = useState("0");
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [advice, setAdvice] = useState<{ fileId: string; storageKey: string; mime: string; byteLength: number; sha256: string } | null>(null);
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

  const errorLine = error && (
    <p role="alert" className="text-sm text-danger">
      {error}
    </p>
  );

  // ---- Step 1: the bank details have to be right before any money moves ----

  if (!readiness.ready) {
    return (
      <div className="flex flex-col gap-3">
        {errorLine}

        {readiness.reason === "no_vendor" && (
          <Notice tone="warn" title="No vendor on this request">
            It hasn&apos;t been accounted to a vendor yet, so there are no bank details to pay. Send it back to accounts.
          </Notice>
        )}

        {readiness.reason === "no_bank" && (
          <Notice tone="warn" title={`No bank details on file for ${readiness.vendorName}`}>
            <a href={`/vendors/${readiness.vendorId}`} target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">
              Open the vendor record
            </a>{" "}
            to add them — or use the fine print below if you have proof in hand right now.
          </Notice>
        )}

        {readiness.reason === "unverified" && (
          <div className="flex flex-col gap-3">
            <p className="text-[13px] text-ink-2">Check these against the bank details printed on the bill before paying.</p>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-lg border border-line-soft bg-sunk p-3 text-[13px]">
              <dt className="text-ink-3">Beneficiary</dt>
              <dd className="m-0 text-right">{readiness.bank.beneficiaryName}</dd>
              <dt className="text-ink-3">Account</dt>
              <dd className="m-0 text-right font-mono">••••••{readiness.bank.accountNumberLast4}</dd>
              <dt className="text-ink-3">IFSC</dt>
              <dd className="m-0 text-right font-mono">{readiness.bank.ifsc}</dd>
              <dt className="text-ink-3">Branch</dt>
              <dd className="m-0 text-right">{readiness.bank.branch ?? "—"}</dd>
            </dl>
            <button
              type="button"
              disabled={pending}
              onClick={() => void run(() => verifyVendorBankAction(requestId, readiness.bank.id))}
              className={buttonClass("primary", "md", true)}
            >
              They match the bill — verify
            </button>
          </div>
        )}

        {(readiness.reason === "no_bank" || readiness.reason === "unverified") && (
          <div className="border-t border-line-soft pt-3">
            {showCorrection ? (
              <div className="flex flex-col gap-2">
                <p className="text-xs text-ink-2">
                  Only if you&apos;re holding proof right now — this is self-verified immediately, and the vendor must already have a document on file.
                </p>
                <input type="text" aria-label="Beneficiary name" value={correctionBeneficiary} onChange={(e) => setCorrectionBeneficiary(e.target.value)} placeholder="Beneficiary name" className={inputClass} />
                <input type="text" inputMode="numeric" aria-label="Account number" value={correctionAccount} onChange={(e) => setCorrectionAccount(e.target.value)} placeholder="Account number" className={`${inputClass} font-mono`} />
                <input type="text" aria-label="IFSC" value={correctionIfsc} onChange={(e) => setCorrectionIfsc(e.target.value)} placeholder="IFSC" className={`${inputClass} font-mono`} />
                <input type="text" aria-label="Branch" value={correctionBranch} onChange={(e) => setCorrectionBranch(e.target.value)} placeholder="Branch (optional)" className={inputClass} />
                <input type="date" aria-label="Effective from" value={correctionEffectiveFrom} onChange={(e) => setCorrectionEffectiveFrom(e.target.value)} className={`${inputClass} font-mono`} />
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={pending || !correctionBeneficiary.trim() || !correctionAccount.trim() || !correctionIfsc.trim()}
                    onClick={() => void saveCorrection()}
                    className={buttonClass("primary", "sm")}
                  >
                    Save — self-verified
                  </button>
                  <button type="button" onClick={() => setShowCorrection(false)} className={buttonClass("secondary", "sm")}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setShowCorrection(true)} className="text-xs text-accent hover:underline">
                I have different, verified bank details in hand
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  // ---- Step 2: record what was paid outside the system ----

  if (returning) {
    return (
      <div className="flex flex-col gap-3">
        {errorLine}
        <div className="flex flex-col gap-1">
          <label htmlFor="return-accounts-reason" className={labelClass}>
            Reason for sending this back to accounts
          </label>
          <textarea id="return-accounts-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className={inputClass} />
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={pending || !reason.trim()}
            onClick={() => void run(() => returnToAccountsAction(requestId, { reason }))}
            className={buttonClass("primary", "sm")}
          >
            Return to accounts
          </button>
          <button type="button" onClick={() => setReturning(false)} className={buttonClass("secondary", "sm")}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const paidMinor = billAmountMinor - balanceMinor;
  const typedMinor = parseAmountToMinor(amount);
  const tdsMinor = parseAmountToMinor(tds) ?? 0;
  // Say what the button will actually do: only a payment that clears the
  // balance once the invoice is in closes the request.
  const amountText = typedMinor === null ? "" : ` of ${formatMinorUnits(typedMinor, currency)}`;
  const payLabel = !invoiceIsIn
    ? `Record advance${amountText}`
    : typedMinor === balanceMinor
      ? `Record ${formatMinorUnits(balanceMinor, currency)} and close`
      : `Record part payment${amountText}`;

  return (
    <div className="flex flex-col gap-3">
      {errorLine}

      {/* The settlement ledger: what is owed, what has moved, what's due.
          Balance is derived server-side; payRequest enforces the ceiling. */}
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-y-1 rounded-lg border border-line-soft bg-sunk p-3 text-[13px]">
        <dt className="text-ink-2">{invoiceIsIn ? "Bill amount" : "Quoted amount"}</dt>
        <dd className="m-0 text-right font-mono tabular-nums">{formatMinorUnits(billAmountMinor, currency)}</dd>
        <dt className="text-ink-2">Paid so far</dt>
        <dd className="m-0 text-right font-mono tabular-nums">− {formatMinorUnits(paidMinor, currency)}</dd>
        <dt className="border-t border-line pt-1 font-semibold">Balance due</dt>
        <dd className="m-0 border-t border-line pt-1 text-right font-mono font-semibold tabular-nums">{formatMinorUnits(balanceMinor, currency)}</dd>
      </dl>
      {!invoiceIsIn && (
        <p className="text-xs text-ink-2">This is an advance. Paying it can&apos;t close the request — that waits for the tax invoice.</p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="pay-from" className={labelClass}>
            Pay from
          </label>
          {accounts.length === 0 ? (
            <p id="pay-from" className="text-[13px] text-ink-2">
              No bank accounts on file for this company yet.
            </p>
          ) : (
            <select id="pay-from" value={accountId} onChange={(e) => setAccountId(e.target.value)} className={inputClass}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label} — {a.bankName}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="pay-mode" className={labelClass}>
            Mode
          </label>
          <select id="pay-mode" value={paymentMode} onChange={(e) => setPaymentMode(e.target.value as PaymentMode)} className={inputClass}>
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="pay-tds" className={labelClass}>
            TDS deducted
          </label>
          <input id="pay-tds" type="text" inputMode="decimal" value={tds} onChange={(e) => setTds(e.target.value)} className={`${inputClass} font-mono`} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="pay-value-date" className={labelClass}>
            Value date
          </label>
          <input id="pay-value-date" type="date" value={valueDate} onChange={(e) => setValueDate(e.target.value)} className={`${inputClass} font-mono`} />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="pay-amount" className={labelClass}>
            Amount paid
          </label>
          {suggestedAmountMinor > 0 && typedMinor !== suggestedAmountMinor && (
            <button type="button" onClick={() => setAmount((suggestedAmountMinor / 100).toFixed(2))} className="text-xs text-accent hover:underline">
              Use {formatMinorUnits(suggestedAmountMinor, currency)}
            </button>
          )}
        </div>
        <input id="pay-amount" type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" className={`${inputClass} font-mono text-lg tabular-nums`} />
        <span className="text-xs text-ink-3">A payment can&apos;t take the total above what this request can settle.</span>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="pay-reference" className={labelClass}>
          UTR / reference <span className="font-normal text-ink-3">required, and can&apos;t be changed later</span>
        </label>
        <input id="pay-reference" type="text" value={reference} onChange={(e) => setReference(e.target.value)} className={`${inputClass} font-mono`} />
      </div>

      <label className={`${buttonClass("secondary", "sm")} cursor-pointer self-start`}>
        {uploading ? "Attaching…" : advice ? "Advice attached ✓" : "Attach payment advice"}
        <input
          type="file"
          accept="application/pdf,image/*"
          disabled={uploading}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void attachAdvice(file);
          }}
        />
      </label>

      <button
        type="button"
        disabled={pending || uploading || !reference.trim() || !accountId || typedMinor === null}
        onClick={() => {
          const account = accounts.find((a) => a.id === accountId);
          if (!account || typedMinor === null) {
            setError("Enter a valid amount.");
            return;
          }
          void run(() =>
            payAction(requestId, { fromAccount: account, mode: paymentMode, valueDate, amountMinor: typedMinor, tdsMinor, reference, advice: advice ?? undefined }),
          );
        }}
        className={buttonClass("primary", "md", true)}
      >
        {payLabel}
      </button>
      <button type="button" onClick={() => setReturning(true)} className={`${buttonClass("secondary", "sm")} self-start`}>
        Return to accounts…
      </button>
    </div>
  );
}
