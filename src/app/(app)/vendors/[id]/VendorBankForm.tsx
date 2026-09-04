"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { setVendorBankAction } from "./actions";

export function VendorBankForm({ vendorId }: { vendorId: string }) {
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
      <button type="button" onClick={() => setEditing(true)} className="self-start text-sm underline">
        Add / update bank details
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
    <div className="flex flex-col gap-2 rounded border border-dashed border-zinc-300 p-3 dark:border-zinc-700">
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        Adding new bank details supersedes the current record and requires fresh verification before the next payment.
      </p>
      <input
        value={beneficiaryName}
        onChange={(e) => setBeneficiaryName(e.target.value)}
        placeholder="Beneficiary name"
        className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
      />
      <input
        value={accountNumber}
        onChange={(e) => setAccountNumber(e.target.value)}
        placeholder="Account number"
        inputMode="numeric"
        className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
      />
      <input
        value={ifsc}
        onChange={(e) => setIfsc(e.target.value)}
        placeholder="IFSC"
        className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
      />
      <input
        value={branch}
        onChange={(e) => setBranch(e.target.value)}
        placeholder="Branch (optional)"
        className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
      />
      <input
        type="date"
        value={effectiveFrom}
        onChange={(e) => setEffectiveFrom(e.target.value)}
        className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
      />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending || !beneficiaryName.trim() || !accountNumber.trim() || !ifsc.trim()}
          onClick={() => void save()}
          className="rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
        >
          Save bank details
        </button>
        <button type="button" onClick={() => setEditing(false)} className="rounded border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700">
          Cancel
        </button>
      </div>
    </div>
  );
}
