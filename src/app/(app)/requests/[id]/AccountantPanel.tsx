"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { accountAction, attachToAdvanceAction, createVendorAction, returnToApproverAction, searchVendorsAction } from "./actions";
import type { DuplicateMatch } from "@/duplicates/duplicateCore";
import { formatMinorUnits } from "@/lib/money";
import type { TransitionResult } from "@/requests/transitions";

type Option = { id: string; name: string };
type VendorMatch = { id: string; name: string; gstin: string | null; pan: string | null };

export function AccountantPanel({
  requestId,
  companies,
  heads,
  vendorNameHint,
  canOverrideDuplicate,
  invoiceNo,
  invoiceDate,
}: {
  requestId: string;
  companies: Option[];
  heads: Option[];
  vendorNameHint: string | null;
  canOverrideDuplicate: boolean;
  // What the bill already says. Attaching it to an advance writes the number
  // into the duplicate index, so it can't be blank; when the requester left
  // either out, the accountant supplies it in the attach card below.
  invoiceNo: string | null;
  invoiceDate: string | null;
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
  // The sixth verdict: the chosen vendor has an advance paid and its tax
  // invoice still awaited. Set from accountAction's refusal, cleared when the
  // vendor changes (the answer belongs to that vendor).
  const [openAdvances, setOpenAdvances] = useState<DuplicateMatch[]>([]);
  const [declineReason, setDeclineReason] = useState("");
  const [attachInvoiceNo, setAttachInvoiceNo] = useState(invoiceNo ?? "");
  const [attachInvoiceDate, setAttachInvoiceDate] = useState(invoiceDate ?? "");

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

  async function confirmAccounting(overrideDuplicateReason?: string, declineOpenAdvanceReason?: string) {
    if (!selectedVendor) return;
    setPending(true);
    setError(null);
    const result: TransitionResult = await accountAction(requestId, {
      companyId,
      vendorId: selectedVendor.id,
      headId,
      voucherNo,
      bookedOn,
      overrideDuplicateReason,
      declineOpenAdvanceReason,
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      // Two different refusals arrive here: the red already-paid block, and
      // the amber open-advance offer. They get different cards.
      if (result.duplicate?.verdict === "matched_advance") {
        setDuplicate(null);
        setOpenAdvances(result.openAdvances ?? [result.duplicate.match]);
      } else {
        setDuplicate(result.duplicate?.match ?? null);
        setOpenAdvances([]);
      }
      return;
    }
    router.refresh();
  }

  // "Attach to REQ-xxxx": no second request is created. This bill closes and
  // its invoice lands on the advance, which is where the person goes next.
  async function attachToAdvance(advanceRequestId: string) {
    if (!selectedVendor) return;
    setPending(true);
    setError(null);
    const result = await attachToAdvanceAction(requestId, {
      advanceRequestId,
      vendorId: selectedVendor.id,
      invoiceNo: invoiceNo ? undefined : attachInvoiceNo,
      invoiceDate: invoiceDate ? undefined : attachInvoiceDate,
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.push(`/requests/${advanceRequestId}`);
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
                <button
                  type="button"
                  onClick={() => {
                    setSelectedVendor(null);
                    setOpenAdvances([]);
                    setDuplicate(null);
                  }}
                  className="text-xs underline"
                >
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
          {openAdvances.length > 0 && (
            <div className="flex flex-col gap-3 rounded border border-amber-400 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
              <p className="font-medium">This vendor has an advance paid and its tax invoice still awaited.</p>
              <p>
                If this bill is that invoice, attach it — booking it as its own request would pay the advance and then pay the full invoice as well.
              </p>
              <ul className="flex flex-col gap-2">
                {openAdvances.map((m) => (
                  <li key={m.requestId} className="flex flex-col gap-2 rounded border border-amber-300 bg-white/60 p-2 dark:border-amber-800 dark:bg-black/30">
                    {m.advance ? (
                      <>
                        <p>
                          <a href={`/requests/${m.requestId}`} target="_blank" rel="noreferrer" className="font-medium underline">
                            {m.advance.ref}
                          </a>{" "}
                          · {formatMinorUnits(m.advance.paidMinor, m.advance.currency)} paid of {formatMinorUnits(m.advance.quotedMinor, m.advance.currency)} quoted
                        </p>
                        <button
                          type="button"
                          disabled={pending || (!invoiceNo && !attachInvoiceNo.trim()) || (!invoiceDate && !attachInvoiceDate)}
                          onClick={() => void attachToAdvance(m.requestId)}
                          className="self-start rounded bg-black px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
                        >
                          Attach to {m.advance.ref}
                        </button>
                      </>
                    ) : (
                      <p>An advance in a department you can&apos;t see{m.viewerHint && <> — {m.viewerHint}</>}. You can&apos;t attach to it from here.</p>
                    )}
                  </li>
                ))}
              </ul>
              {(!invoiceNo || !invoiceDate) && openAdvances.some((m) => m.advance) && (
                <div className="flex flex-col gap-2">
                  <p className="text-xs text-zinc-600 dark:text-zinc-400">The bill has no {!invoiceNo && "invoice number"}{!invoiceNo && !invoiceDate && " or "}{!invoiceDate && "invoice date"} on it. Attaching needs it.</p>
                  {!invoiceNo && (
                    <input
                      type="text"
                      value={attachInvoiceNo}
                      onChange={(e) => setAttachInvoiceNo(e.target.value)}
                      placeholder="Invoice number"
                      className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
                    />
                  )}
                  {!invoiceDate && (
                    <input
                      type="date"
                      value={attachInvoiceDate}
                      onChange={(e) => setAttachInvoiceDate(e.target.value)}
                      className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
                    />
                  )}
                </div>
              )}
              <div className="flex flex-col gap-2 border-t border-amber-300 pt-2 dark:border-amber-800">
                <textarea
                  value={declineReason}
                  onChange={(e) => setDeclineReason(e.target.value)}
                  placeholder="Why this is a different bill, not the advance's invoice"
                  aria-label="Why this is a different bill"
                  rows={2}
                  className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
                />
                <button
                  type="button"
                  disabled={pending || !declineReason.trim() || !companyId || !headId || !voucherNo.trim()}
                  onClick={() => void confirmAccounting(undefined, declineReason)}
                  className="self-start rounded border border-amber-600 px-3 py-2 text-sm font-medium text-amber-900 disabled:opacity-50 dark:text-amber-200"
                >
                  Different bill — account it separately
                </button>
                <p className="text-xs text-zinc-600 dark:text-zinc-400">Recorded in the request&apos;s trail with your reason.</p>
              </div>
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
