"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Notice } from "@/ui/Notice";
import { buttonClass, inputClass, labelClass } from "@/ui/styles";
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
  const [returning, setReturning] = useState(false);
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

  const errorLine = error && (
    <p role="alert" className="text-sm text-danger">
      {error}
    </p>
  );

  if (returning) {
    return (
      <div className="flex flex-col gap-3">
        {errorLine}
        <div className="flex flex-col gap-1">
          <label htmlFor="return-approver-reason" className={labelClass}>
            Reason for sending this back to the approver
          </label>
          <textarea id="return-approver-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className={inputClass} />
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={pending || !reason.trim()}
            onClick={() => void run(() => returnToApproverAction(requestId, { reason }))}
            className={buttonClass("primary", "sm")}
          >
            Return to approver
          </button>
          <button type="button" onClick={() => setReturning(false)} className={buttonClass("secondary", "sm")}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {errorLine}

      <div className="flex flex-col gap-1.5">
        <span className={labelClass}>Vendor</span>
        {selectedVendor ? (
          <div className="flex items-start justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-2">
            <span className="flex flex-col">
              <span className="text-sm font-semibold">{selectedVendor.name}</span>
              {(selectedVendor.gstin || selectedVendor.pan) && (
                <span className="font-mono text-[11.5px] text-ink-3">{selectedVendor.gstin ?? selectedVendor.pan}</span>
              )}
            </span>
            <button type="button" onClick={() => setSelectedVendor(null)} className="text-xs text-accent hover:underline">
              Change
            </button>
          </div>
        ) : (
          <>
            <div className="flex gap-2">
              <input
                type="text"
                aria-label="Vendor name, GSTIN or PAN"
                value={vendorTerm}
                onChange={(e) => {
                  setVendorTerm(e.target.value);
                  setHasSearched(false);
                  setVendorMatches([]);
                }}
                placeholder="Name, GSTIN or PAN"
                className={inputClass}
              />
              <button type="button" disabled={vendorSearchPending || !vendorTerm.trim()} onClick={() => void searchVendor()} className={buttonClass("secondary", "sm")}>
                {vendorSearchPending ? "Searching…" : "Search"}
              </button>
            </div>
            {vendorMatches.length > 0 && (
              <ul className="flex flex-col gap-1">
                {vendorMatches.map((v) => (
                  <li key={v.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedVendor(v)}
                      className="flex w-full flex-col rounded-lg border border-line px-3 py-2 text-left hover:border-accent hover:bg-accent-soft"
                    >
                      <span className="text-sm font-medium">{v.name}</span>
                      {v.gstin && <span className="font-mono text-[11.5px] text-ink-3">{v.gstin}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {hasSearched && vendorMatches.length === 0 && !vendorSearchPending && vendorTerm.trim() && (
              <div className="flex flex-col gap-2 rounded-lg border border-dashed border-line p-3">
                {showCreateVendor ? (
                  <>
                    <p className="text-xs text-ink-2">No match. Create &ldquo;{vendorTerm}&rdquo; as a new vendor.</p>
                    <input type="text" aria-label="GSTIN" value={newVendorGstin} onChange={(e) => setNewVendorGstin(e.target.value)} placeholder="GSTIN (optional)" className={`${inputClass} font-mono uppercase`} />
                    <input type="text" aria-label="PAN" value={newVendorPan} onChange={(e) => setNewVendorPan(e.target.value)} placeholder="PAN (optional)" className={`${inputClass} font-mono uppercase`} />
                    <button type="button" disabled={pending} onClick={() => void createVendor()} className={`${buttonClass("primary", "sm")} self-start`}>
                      Create vendor
                    </button>
                  </>
                ) : (
                  <button type="button" onClick={() => setShowCreateVendor(true)} className="text-sm text-accent hover:underline">
                    No match — create &ldquo;{vendorTerm}&rdquo; as a new vendor
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="account-company" className={labelClass}>
            Company
          </label>
          {companies.length === 0 ? (
            <p id="account-company" className="text-[13px] text-ink-2">
              No companies are in your scope — an admin needs to grant company scope.
            </p>
          ) : (
            <select id="account-company" value={companyId} onChange={(e) => setCompanyId(e.target.value)} className={inputClass}>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="account-head" className={labelClass}>
            Head
          </label>
          <select id="account-head" value={headId} onChange={(e) => setHeadId(e.target.value)} className={inputClass}>
            {heads.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="account-voucher" className={labelClass}>
            Voucher number
          </label>
          <input id="account-voucher" type="text" value={voucherNo} onChange={(e) => setVoucherNo(e.target.value)} className={`${inputClass} font-mono`} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="account-booked-on" className={labelClass}>
            Booked on
          </label>
          <input id="account-booked-on" type="date" value={bookedOn} onChange={(e) => setBookedOn(e.target.value)} className={`${inputClass} font-mono`} />
        </div>
      </div>

      {duplicate && (
        <Notice tone="danger" title="This vendor and invoice number were already paid">
          {duplicate.viewableByActor ? (
            <>
              It matches a request that is {duplicate.stage.replaceAll("_", " ")}
              {duplicate.reference && (
                <>
                  , UTR <span className="font-mono">{duplicate.reference}</span>
                </>
              )}
              .
            </>
          ) : (
            <>It matches a request in a department you can&apos;t see{duplicate.viewerHint && <> — {duplicate.viewerHint}</>}.</>
          )}
          {canOverrideDuplicate && (
            <div className="mt-2 flex flex-col gap-2 border-t border-danger-line pt-2">
              <label htmlFor="account-override" className={labelClass}>
                Super admin override — reason
              </label>
              <textarea id="account-override" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} rows={2} className={inputClass} />
              <button
                type="button"
                disabled={pending || !overrideReason.trim()}
                onClick={() => void confirmAccounting(overrideReason)}
                className={`${buttonClass("danger", "sm")} self-start`}
              >
                Override and book anyway
              </button>
            </div>
          )}
        </Notice>
      )}

      <button
        type="button"
        disabled={pending || !companyId || !headId || !voucherNo.trim() || !selectedVendor}
        onClick={() => void confirmAccounting()}
        className={buttonClass("primary", "md", true)}
      >
        Confirm accounting · send to pay
      </button>
      <button type="button" onClick={() => setReturning(true)} className={`${buttonClass("secondary", "sm")} self-start`}>
        Return to approver…
      </button>
    </div>
  );
}
