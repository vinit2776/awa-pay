"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { updateVendorProfileAction } from "./actions";
import type { VendorDetail } from "@/vendors/vendorsCore";

type Head = { id: string; name: string };

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
      <button type="button" onClick={() => setEditing(true)} className="self-start text-sm underline">
        Edit vendor details
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
    <div className="flex flex-col gap-2 rounded border border-zinc-300 p-4 dark:border-zinc-700">
      <h2 className="text-sm font-medium">Edit vendor details</h2>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black" />
        <input value={type} onChange={(e) => setType(e.target.value)} placeholder="Type (e.g. Private limited)" className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black" />
        <input value={gstin} onChange={(e) => setGstin(e.target.value)} placeholder="GSTIN" className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black" />
        <input value={pan} onChange={(e) => setPan(e.target.value)} placeholder="PAN" className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black" />
        <input value={udyam} onChange={(e) => setUdyam(e.target.value)} placeholder="MSME / Udyam" className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black" />
        <input value={tdsSection} onChange={(e) => setTdsSection(e.target.value)} placeholder="TDS section (e.g. 194C)" className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black" />
        <input value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Contact name" className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black" />
        <input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="Contact phone" className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black" />
        <input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="Contact email" className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black" />
        <input
          type="number"
          value={paymentTermsDays}
          onChange={(e) => setPaymentTermsDays(e.target.value)}
          placeholder="Payment terms (days)"
          className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
        />
        <select value={defaultHeadId} onChange={(e) => setDefaultHeadId(e.target.value)} className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black">
          <option value="">No default head</option>
          {heads.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
      </div>
      <textarea
        value={registeredAddress}
        onChange={(e) => setRegisteredAddress(e.target.value)}
        placeholder="Registered address"
        rows={2}
        className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
      />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending || !name.trim()}
          onClick={() => void save()}
          className="rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
        >
          Save
        </button>
        <button type="button" onClick={() => setEditing(false)} className="rounded border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700">
          Cancel
        </button>
      </div>
    </div>
  );
}
