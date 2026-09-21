"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { buttonClass, inputClass, labelClass } from "@/ui/styles";
import { setVendorBankAction } from "./actions";

export function VendorBankForm({ vendorId, hasCurrent }: { vendorId: string; hasCurrent: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [beneficiaryName, setBeneficiaryName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [ifsc, setIfsc] = useState("");
  const [branch, setBranch] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(() => new Date().toISOString().slice(0, 10));

  if (!editing) {
    return (
      <button type="button" onClick={() => setEditing(true)} className={`${buttonClass("secondary", "sm")} self-start`}>
        {hasCurrent ? "Replace bank details" : "Add bank details"}
      </button>
    );
  }

  async function save() {
    setPending(true);
    setError(null);
    const result = await setVendorBankAction(vendorId, { beneficiaryName, accountNumber, ifsc, branch: branch || null, effectiveFrom });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setEditing(false);
    setAccountNumber("");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-dashed border-line p-3">
      <p className="text-xs text-ink-2">
        {hasCurrent
          ? "This becomes a new version. The current details are kept in the history, and every open request for this vendor needs fresh verification before it's paid."
          : "New details need verifying by a payer against a bill before the first payment."}
      </p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="grid gap-2.5 sm:grid-cols-2">
        <div className="flex flex-col gap-1 sm:col-span-2">
          <label htmlFor="bank-beneficiary" className={labelClass}>
            Beneficiary name
          </label>
          <input id="bank-beneficiary" value={beneficiaryName} onChange={(e) => setBeneficiaryName(e.target.value)} className={inputClass} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="bank-account" className={labelClass}>
            Account number
          </label>
          <input id="bank-account" value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} inputMode="numeric" autoComplete="off" className={`${inputClass} font-mono`} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="bank-ifsc" className={labelClass}>
            IFSC
          </label>
          <input id="bank-ifsc" value={ifsc} onChange={(e) => setIfsc(e.target.value)} className={`${inputClass} font-mono uppercase`} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="bank-branch" className={labelClass}>
            Branch <span className="font-normal text-ink-3">optional</span>
          </label>
          <input id="bank-branch" value={branch} onChange={(e) => setBranch(e.target.value)} className={inputClass} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="bank-effective" className={labelClass}>
            Effective from
          </label>
          <input id="bank-effective" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} className={`${inputClass} font-mono`} />
        </div>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending || !beneficiaryName.trim() || !accountNumber.trim() || !ifsc.trim()}
          onClick={() => void save()}
          className={buttonClass("primary", "sm")}
        >
          {pending ? "Saving…" : "Save bank details"}
        </button>
        <button type="button" onClick={() => setEditing(false)} className={buttonClass("secondary", "sm")}>
          Cancel
        </button>
      </div>
    </div>
  );
}
