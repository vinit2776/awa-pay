"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { buttonClass, inputClass, labelClass } from "@/ui/styles";
import { updateVendorProfileAction } from "./actions";
import type { VendorDetail } from "@/vendors/vendorsCore";

type Head = { id: string; name: string };

function Field({ id, label, wide, children }: { id: string; label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`flex flex-col gap-1 ${wide ? "sm:col-span-2" : ""}`}>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      {children}
    </div>
  );
}

// Opens as a sheet over the page rather than inline, so the read-only
// summary stays the thing people see by default.
export function VendorProfileForm({ vendor, heads }: { vendor: VendorDetail; heads: Head[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(vendor.name);
  const [type, setType] = useState(vendor.type ?? "");
  const [gstin, setGstin] = useState(vendor.gstin ?? "");
  const [pan, setPan] = useState(vendor.pan ?? "");
  const [udyam, setUdyam] = useState(vendor.udyam ?? "");
  const [tdsSection, setTdsSection] = useState(vendor.tdsSection ?? "");
  const [registeredAddress, setRegisteredAddress] = useState(vendor.registeredAddress ?? "");
  const [contactName, setContactName] = useState(vendor.contactName ?? "");
  const [contactPhone, setContactPhone] = useState(vendor.contactPhone ?? "");
  const [contactEmail, setContactEmail] = useState(vendor.contactEmail ?? "");
  const [paymentTermsDays, setPaymentTermsDays] = useState(vendor.paymentTermsDays?.toString() ?? "");
  const [defaultHeadId, setDefaultHeadId] = useState(vendor.defaultHeadId ?? "");

  if (!editing) {
    return (
      <button type="button" onClick={() => setEditing(true)} className={buttonClass("secondary", "sm")}>
        Edit details
      </button>
    );
  }

  async function save() {
    setPending(true);
    setError(null);
    const result = await updateVendorProfileAction(vendor.id, {
      name,
      type: type || null,
      gstin: gstin || null,
      pan: pan || null,
      udyam: udyam || null,
      tdsSection: tdsSection || null,
      registeredAddress: registeredAddress || null,
      contactName: contactName || null,
      contactPhone: contactPhone || null,
      contactEmail: contactEmail || null,
      paymentTermsDays: paymentTermsDays ? Number(paymentTermsDays) : null,
      defaultHeadId: defaultHeadId || null,
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setEditing(false);
    router.refresh();
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-ink/40 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="vendor-edit-title">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col gap-4 overflow-y-auto rounded-t-2xl bg-surface p-5 sm:rounded-2xl">
        <h2 id="vendor-edit-title" className="text-lg font-semibold">
          Edit vendor details
        </h2>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="vendor-name" label="Name" wide>
            <input id="vendor-name" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
          </Field>
          <Field id="vendor-type" label="Type">
            <input id="vendor-type" value={type} onChange={(e) => setType(e.target.value)} placeholder="e.g. Private limited" className={inputClass} />
          </Field>
          <Field id="vendor-tds" label="TDS section">
            <input id="vendor-tds" value={tdsSection} onChange={(e) => setTdsSection(e.target.value)} placeholder="e.g. 194C" className={`${inputClass} font-mono`} />
          </Field>
          <Field id="vendor-gstin" label="GSTIN">
            <input id="vendor-gstin" value={gstin} onChange={(e) => setGstin(e.target.value)} className={`${inputClass} font-mono uppercase`} />
          </Field>
          <Field id="vendor-pan" label="PAN">
            <input id="vendor-pan" value={pan} onChange={(e) => setPan(e.target.value)} className={`${inputClass} font-mono uppercase`} />
          </Field>
          <Field id="vendor-udyam" label="MSME / Udyam">
            <input id="vendor-udyam" value={udyam} onChange={(e) => setUdyam(e.target.value)} className={`${inputClass} font-mono uppercase`} />
          </Field>
          <Field id="vendor-terms" label="Payment terms (days)">
            <input id="vendor-terms" type="number" min={0} value={paymentTermsDays} onChange={(e) => setPaymentTermsDays(e.target.value)} className={inputClass} />
          </Field>
          <Field id="vendor-contact" label="Contact name">
            <input id="vendor-contact" value={contactName} onChange={(e) => setContactName(e.target.value)} className={inputClass} />
          </Field>
          <Field id="vendor-phone" label="Contact phone">
            <input id="vendor-phone" type="tel" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} className={`${inputClass} font-mono`} />
          </Field>
          <Field id="vendor-email" label="Contact email">
            <input id="vendor-email" type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} className={inputClass} />
          </Field>
          <Field id="vendor-head" label="Default head">
            <select id="vendor-head" value={defaultHeadId} onChange={(e) => setDefaultHeadId(e.target.value)} className={inputClass}>
              <option value="">No default head</option>
              {heads.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </Field>
          <Field id="vendor-address" label="Registered address" wide>
            <textarea id="vendor-address" value={registeredAddress} onChange={(e) => setRegisteredAddress(e.target.value)} rows={2} className={inputClass} />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => setEditing(false)} className={buttonClass("secondary", "sm")}>
            Cancel
          </button>
          <button type="button" disabled={pending || !name.trim()} onClick={() => void save()} className={buttonClass("primary", "sm")}>
            {pending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
