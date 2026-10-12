"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { accountAction, addVendorBankAction, createVendorAction, returnToApproverAction, searchVendorsAction } from "./actions";
import type { DuplicateMatch } from "@/duplicates/duplicateCore";
import type { TransitionResult } from "@/requests/transitions";
import type { VendorBankSummary, VendorSummary } from "@/vendors/vendorsCore";

type Option = { id: string; name: string };
type VendorMatch = VendorSummary;

const inputClass = "rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black";

type BankFieldsState = { beneficiary: string; account: string; ifsc: string; branch: string };
const EMPTY_BANK: BankFieldsState = { beneficiary: "", account: "", ifsc: "", branch: "" };

// Nothing typed, or everything required typed. Half a bank record is the
// state to refuse: it is what a rushed accountant leaves behind. The
// beneficiary alone doesn't count as typing, because it is pre-filled with
// the vendor's name.
function bankStatus(b: BankFieldsState): "empty" | "partial" | "complete" {
  if ([b.account, b.ifsc, b.branch].every((v) => v.trim() === "")) return "empty";
  return [b.beneficiary, b.account, b.ifsc].every((v) => v.trim() !== "") ? "complete" : "partial";
}

function toSummary(b: BankFieldsState): VendorBankSummary {
  return { beneficiaryName: b.beneficiary.trim(), accountNumberLast4: b.account.trim().slice(-4), ifsc: b.ifsc.trim().toUpperCase(), branch: b.branch.trim() || null, verified: false };
}

function BankFields({ value, onChange }: { value: BankFieldsState; onChange: (next: BankFieldsState) => void }) {
  return (
    <>
      <input value={value.beneficiary} onChange={(e) => onChange({ ...value, beneficiary: e.target.value })} placeholder="Beneficiary name (as on the bank account)" className={inputClass} />
      <input value={value.account} onChange={(e) => onChange({ ...value, account: e.target.value })} placeholder="Account number" inputMode="numeric" className={inputClass} />
      <input value={value.ifsc} onChange={(e) => onChange({ ...value, ifsc: e.target.value })} placeholder="IFSC" className={inputClass} />
      <input value={value.branch} onChange={(e) => onChange({ ...value, branch: e.target.value })} placeholder="Branch (optional)" className={inputClass} />
    </>
  );
}

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

  // Bank details: typed into the create-vendor form, or into the bank
  // section for a vendor that has none (or to replace the one on file).
  const [bank, setBank] = useState<BankFieldsState>(EMPTY_BANK);
  const [replacingBank, setReplacingBank] = useState(false);

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

  async function saveBank() {
    if (!selectedVendor) return;
    setPending(true);
    setError(null);
    const result = await addVendorBankAction(requestId, selectedVendor.id, {
      beneficiaryName: bank.beneficiary,
      accountNumber: bank.account.trim(),
      ifsc: bank.ifsc,
      branch: bank.branch.trim() || null,
      effectiveFrom: new Date().toISOString().slice(0, 10),
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSelectedVendor({ ...selectedVendor, bank: toSummary(bank) });
    setBank(EMPTY_BANK);
    setReplacingBank(false);
    router.refresh();
  }

  async function createVendor() {
    setPending(true);
    setError(null);
    const withBank = bankStatus(bank) === "complete";
    const result = await createVendorAction(requestId, {
      name: vendorTerm,
      gstin: newVendorGstin || null,
      pan: newVendorPan || null,
      bank: withBank
        ? { beneficiaryName: bank.beneficiary, accountNumber: bank.account.trim(), ifsc: bank.ifsc, branch: bank.branch.trim() || null, effectiveFrom: new Date().toISOString().slice(0, 10) }
        : null,
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSelectedVendor({ id: result.id, name: vendorTerm, gstin: newVendorGstin || null, pan: newVendorPan || null, bank: withBank ? toSummary(bank) : null });
    setShowCreateVendor(false);
    setVendorMatches([]);
    setBank(EMPTY_BANK);
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
                    setBank(EMPTY_BANK);
                    setReplacingBank(false);
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
                        <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Bank details — the payer verifies these against the bill</p>
                        <BankFields value={bank} onChange={setBank} />
                        {bankStatus(bank) === "partial" && <p className="text-xs text-amber-700 dark:text-amber-300">Fill in beneficiary, account number and IFSC, or leave the bank details empty.</p>}
                        <button
                          type="button"
                          disabled={pending || bankStatus(bank) === "partial"}
                          onClick={() => void createVendor()}
                          className="rounded bg-black px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
                        >
                          Create vendor
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setBank((b) => ({ ...b, beneficiary: b.beneficiary || vendorTerm }));
                          setShowCreateVendor(true);
                        }}
                        className="text-sm underline"
                      >
                        No match — create a new vendor
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {selectedVendor && (
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Bank account</label>
              {selectedVendor.bank && !replacingBank ? (
                <div className="flex items-start justify-between gap-3 rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700">
                  <span>
                    {selectedVendor.bank.beneficiaryName} · ••••{selectedVendor.bank.accountNumberLast4} · {selectedVendor.bank.ifsc}
                    {selectedVendor.bank.branch && <span className="text-zinc-500"> · {selectedVendor.bank.branch}</span>}
                    <span className={`block text-xs ${selectedVendor.bank.verified ? "text-green-700 dark:text-green-400" : "text-amber-700 dark:text-amber-300"}`}>
                      {selectedVendor.bank.verified ? "Verified by the payer earlier" : "Not yet verified — the payer verifies it against the bill"}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setBank({ ...EMPTY_BANK, beneficiary: selectedVendor.bank?.beneficiaryName ?? "" });
                      setReplacingBank(true);
                    }}
                    className="shrink-0 text-xs underline"
                  >
                    Use different details
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-2 rounded border border-dashed border-zinc-300 p-3 dark:border-zinc-700">
                  <p className="text-xs text-zinc-600 dark:text-zinc-400">
                    {selectedVendor.bank
                      ? "These replace the bank account on file and need fresh verification by the payer before the next payment."
                      : "This vendor has no bank details on file. Add them so the payer only has to verify them against the bill."}
                  </p>
                  <BankFields value={bank} onChange={setBank} />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={pending || bankStatus(bank) !== "complete"}
                      onClick={() => void saveBank()}
                      className="rounded bg-black px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
                    >
                      Save bank details
                    </button>
                    {selectedVendor.bank && (
                      <button
                        type="button"
                        onClick={() => {
                          setReplacingBank(false);
                          setBank(EMPTY_BANK);
                        }}
                        className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700"
                      >
                        Keep the one on file
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

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
          {selectedVendor && (!selectedVendor.bank || replacingBank) && (
            <p className="text-xs text-zinc-600 dark:text-zinc-400">Save the vendor&apos;s bank details to confirm accounting.</p>
          )}
          <button
            type="button"
            disabled={pending || !companyId || !headId || !voucherNo.trim() || !selectedVendor || !selectedVendor.bank || replacingBank}
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
