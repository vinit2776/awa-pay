"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { accountAction, returnToApproverAction } from "./actions";

type Option = { id: string; name: string };

export function AccountantPanel({
  requestId,
  companies,
  heads,
}: {
  requestId: string;
  companies: Option[];
  heads: Option[];
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"account" | "return">("account");
  const [companyId, setCompanyId] = useState(companies[0]?.id ?? "");
  const [headId, setHeadId] = useState(heads[0]?.id ?? "");
  const [voucherNo, setVoucherNo] = useState("");
  const [bookedOn, setBookedOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState("");
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

  return (
    <div className="flex flex-col gap-3 rounded border border-zinc-300 p-4 dark:border-zinc-700">
      <div className="flex gap-2 text-sm">
        <button type="button" onClick={() => setMode("account")} className={mode === "account" ? "font-semibold underline" : ""}>
          Account this bill
        </button>
        <button type="button" onClick={() => setMode("return")} className={mode === "return" ? "font-semibold underline" : ""}>
          Return to approver
        </button>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {mode === "account" ? (
        <>
          {companies.length === 0 ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              No companies are in your scope — an admin needs to grant company scope.
            </p>
          ) : (
            <select
              value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}
              className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
            >
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          <select
            value={headId}
            onChange={(e) => setHeadId(e.target.value)}
            className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
          >
            {heads.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={voucherNo}
            onChange={(e) => setVoucherNo(e.target.value)}
            placeholder="Voucher number"
            className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
          />
          <input
            type="date"
            value={bookedOn}
            onChange={(e) => setBookedOn(e.target.value)}
            className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
          />
          <button
            type="button"
            disabled={pending || !companyId || !headId || !voucherNo.trim()}
            onClick={() => void run(() => accountAction(requestId, { companyId, headId, voucherNo, bookedOn }))}
            className="rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
          >
            Confirm accounting
          </button>
        </>
      ) : (
        <>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason for sending back to the approver"
            rows={2}
            className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
          />
          <button
            type="button"
            disabled={pending || !reason.trim()}
            onClick={() => void run(() => returnToApproverAction(requestId, { reason }))}
            className="rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
          >
            Return to approver
          </button>
        </>
      )}
    </div>
  );
}
