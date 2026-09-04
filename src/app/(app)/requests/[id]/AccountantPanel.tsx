"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { accountAction, createVendorAction, returnToApproverAction, searchVendorsAction } from "./actions";
import type { DuplicateMatch } from "@/duplicates/duplicateCore";
import type { TransitionResult } from "@/requests/transitions";

type Option = { id: string; name: string };
type VendorMatch = { id: string; name: string; gstin: string | null; pan: string | null };

export function AccountantPanel({
  requestId,
  companies,
  heads,
  vendorNameHint,
  canOverrideDuplicate,
}: {
  requestId: string;
  companies: Option[];
  heads: Option[];
  vendorNameHint: string | null;
  canOverrideDuplicate: boolean;
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
  const [duplicate, setDuplicate] = useState<DuplicateMatch | null>(null);
  const [overrideReason, setOverrideReason] = useState("");

  // Vendor matching — pre-filled from the requester's own free-text
  // capture, since they already typed a name (docs/START-HERE-slice-3.md's
  // "Vendor matching at the accounts desk" design decision).
  const [vendorTerm, setVendorTerm] = useState(vendorNameHint ?? "");
  const [vendorMatches, setVendorMatches] = useState<VendorMatch[]>([]);
  const [vendorSearchPending, setVendorSearchPending] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [selectedVendor, setSelectedVendor] = useState<VendorMatch | null>(null);
  const [showCreateVendor, setShowCreateVendor] = useState(false);
  const [newVendorGstin, setNewVendorGstin] = useState("");
  const [newVendorPan, setNewVendorPan] = useState("");

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

  async function confirmAccounting(overrideDuplicateReason?: string) {
    if (!selectedVendor) return;
    setPending(true);
    setError(null);
    const result: TransitionResult = await accountAction(requestId, { companyId, vendorId: selectedVendor.id, headId, voucherNo, bookedOn, overrideDuplicateReason });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      setDuplicate(result.duplicate?.match ?? null);
      return;
    }
    router.refresh();
  }

  async function searchVendor() {
    setVendorSearchPending(true);
    setSelectedVendor(null);
    const matches = await searchVendorsAction(vendorTerm);
    setVendorMatches(matches);
    setVendorSearchPending(false);
    setHasSearched(true);
  }

  async function createVendor() {
    setPending(true);
    setError(null);
    const result = await createVendorAction(requestId, { name: vendorTerm, gstin: newVendorGstin || null, pan: newVendorPan || null });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSelectedVendor({ id: result.id, name: vendorTerm, gstin: newVendorGstin || null, pan: newVendorPan || null });
    setShowCreateVendor(false);
    setVendorMatches([]);
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
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Vendor</label>
            {selectedVendor ? (
              <div className="flex items-center justify-between rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700">
                <span>
                  {selectedVendor.name}
                  {selectedVendor.gstin && <span className="text-zinc-500"> · {selectedVendor.gstin}</span>}
                </span>
                <button type="button" onClick={() => setSelectedVendor(null)} className="text-xs underline">
                  Change
                </button>
              </div>
            ) : (
              <>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={vendorTerm}
                    onChange={(e) => {
                      setVendorTerm(e.target.value);
                      setHasSearched(false);
                      setVendorMatches([]);
                    }}
                    placeholder="Vendor name, GSTIN or PAN"
                    className="flex-1 rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
                  />
                  <button
                    type="button"
                    disabled={vendorSearchPending || !vendorTerm.trim()}
                    onClick={() => void searchVendor()}
                    className="rounded border border-zinc-300 px-3 py-2 text-sm disabled:opacity-50 dark:border-zinc-700"
                  >
                    Search
                  </button>
                </div>
                {vendorMatches.length > 0 && (
                  <ul className="flex flex-col gap-1">
                    {vendorMatches.map((v) => (
                      <li key={v.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedVendor(v)}
                          className="w-full rounded border border-zinc-300 px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                        >
                          {v.name}
                          {v.gstin && <span className="text-zinc-500"> · {v.gstin}</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {hasSearched && vendorMatches.length === 0 && !vendorSearchPending && vendorTerm.trim() && (
                  <div className="flex flex-col gap-2 rounded border border-dashed border-zinc-300 p-3 dark:border-zinc-700">
                    {showCreateVendor ? (
                      <>
                        <p className="text-xs text-zinc-600 dark:text-zinc-400">No match — create &quot;{vendorTerm}&quot; as a new vendor.</p>
                        <input
                          type="text"
                          value={newVendorGstin}
                          onChange={(e) => setNewVendorGstin(e.target.value)}
                          placeholder="GSTIN (optional)"
                          className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
                        />
                        <input
                          type="text"
                          value={newVendorPan}
                          onChange={(e) => setNewVendorPan(e.target.value)}
                          placeholder="PAN (optional)"
                          className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
                        />
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => void createVendor()}
                          className="rounded bg-black px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
                        >
                          Create vendor
                        </button>
                      </>
                    ) : (
                      <button type="button" onClick={() => setShowCreateVendor(true)} className="text-sm underline">
                        No match — create a new vendor
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

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
          {duplicate && (
            <div className="flex flex-col gap-2 rounded border border-red-400 bg-red-50 p-3 text-sm dark:border-red-800 dark:bg-red-950">
              <p className="font-medium">This vendor + invoice number was already paid on another request.</p>
              {duplicate.viewableByActor ? (
                <p>
                  Matches request in stage &quot;{duplicate.stage}&quot;{duplicate.reference && <> · UTR {duplicate.reference}</>}.
                </p>
              ) : (
                <p>Matches a request in a department you can&apos;t see{duplicate.viewerHint && <> — {duplicate.viewerHint}</>}.</p>
              )}
              {canOverrideDuplicate && (
                <div className="flex flex-col gap-2 border-t border-red-300 pt-2 dark:border-red-800">
                  <textarea
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                    placeholder="Reason for overriding this match"
                    rows={2}
                    className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
                  />
                  <button
                    type="button"
                    disabled={pending || !overrideReason.trim()}
                    onClick={() => void confirmAccounting(overrideReason)}
                    className="self-start rounded border border-red-500 px-3 py-2 text-sm font-medium text-red-700 disabled:opacity-50 dark:text-red-300"
                  >
                    Override and account anyway
                  </button>
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            disabled={pending || !companyId || !headId || !voucherNo.trim() || !selectedVendor}
            onClick={() => void confirmAccounting()}
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
