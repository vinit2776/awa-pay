import { eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { verifySession } from "@/auth/dal";
import { withGrantScope } from "@/db/runtime";
import { headOfAccount, user, vendorBank } from "@/db/schema";
import { formatMinorUnits } from "@/lib/money";
import { presignGetUrl } from "@/storage/r2";
import { Pill } from "@/ui/Pill";
import { eyebrowClass } from "@/ui/styles";
import { tdsRateLabel } from "@/vendors/tds";
import { bankVersions, indianFinancialYear, paidInFinancialYear } from "@/vendors/vendorDisplay";
import { getVendor, listVendorPaymentHistory } from "@/vendors/vendorsCore";
import { resolveVendorViewerRoles, resolveVendorWriterRole } from "@/vendors/viewerRole";
import { VendorBankForm } from "./VendorBankForm";
import { VendorDocumentUpload } from "./VendorDocumentUpload";
import { VendorProfileForm } from "./VendorProfileForm";

const DOCUMENT_KIND_LABELS: Record<string, string> = {
  gst_certificate: "GST certificate",
  pan_card: "PAN card",
  udyam_certificate: "Udyam certificate",
  cancelled_cheque: "Cancelled cheque",
  other: "Other",
};

function onDate(d: Date): string {
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
}

// A label/value row. A missing value says so plainly rather than showing
// a dash — "not on file" is the fact a KYC check needs.
function Fact({ label, value, mono }: { label: string; value: ReactNode | null | undefined; mono?: boolean }) {
  const missing = value === null || value === undefined || value === "";
  return (
    <>
      <dt className="text-ink-3">{label}</dt>
      <dd className={`m-0 text-right wrap-anywhere ${missing ? "text-warn" : mono ? "font-mono" : ""}`}>{missing ? "Not on file" : value}</dd>
    </>
  );
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className={eyebrowClass}>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export default async function VendorPage({ params }: PageProps<"/vendors/[id]">) {
  const { id } = await params;
  const session = await verifySession();

  const roles = await resolveVendorViewerRoles(session.userId);
  if (roles.length === 0) {
    notFound();
  }
  const role = roles[0];
  const editRole = await resolveVendorWriterRole(session.userId);
  const canEdit = editRole !== null;

  const found = await getVendor(session.userId, role, id);
  if (!found) {
    notFound();
  }
  const { vendor, currentBank, documents } = found;

  const enteredBy = alias(user, "entered_by_user");
  const verifiedBy = alias(user, "verified_by_user");
  const [defaultHead, bankRows] = await withGrantScope(session.userId, role, async (tx) => {
    const [head] = vendor.defaultHeadId ? await tx.select().from(headOfAccount).where(eq(headOfAccount.id, vendor.defaultHeadId)).limit(1) : [null];
    // Every version, not just the live one — never the encrypted account
    // number, only the last four digits the page already shows.
    const rows = await tx
      .select({
        id: vendorBank.id,
        beneficiaryName: vendorBank.beneficiaryName,
        accountNumberLast4: vendorBank.accountNumberLast4,
        ifsc: vendorBank.ifsc,
        branch: vendorBank.branch,
        effectiveFrom: vendorBank.effectiveFrom,
        supersededAt: vendorBank.supersededAt,
        verifiedAt: vendorBank.verifiedAt,
        enteredAsRole: vendorBank.enteredAsRole,
        enteredByName: enteredBy.name,
        verifiedByName: verifiedBy.name,
      })
      .from(vendorBank)
      .leftJoin(enteredBy, eq(enteredBy.id, vendorBank.enteredBy))
      .leftJoin(verifiedBy, eq(verifiedBy.id, vendorBank.verifiedBy))
      .where(eq(vendorBank.vendorId, id));
    return [head ?? null, rows] as const;
  });

  const payments = await listVendorPaymentHistory(session.userId, role, id);
  const documentsWithUrls = await Promise.all(documents.map(async (d) => ({ ...d, downloadUrl: await presignGetUrl(d.storageKey) })));

  const versions = bankVersions(bankRows);
  const live = versions.find((v) => v.current) ?? null;
  const past = versions.filter((v) => !v.current).reverse();
  const fy = indianFinancialYear(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()));
  const thisYear = paidInFinancialYear(payments, fy);

  const heads = canEdit && editRole ? await withGrantScope(session.userId, editRole, (tx) => tx.select().from(headOfAccount).where(eq(headOfAccount.active, true))) : [];

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 px-4 py-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <span className={eyebrowClass}>
            {vendor.type ?? "Vendor"}
            {!vendor.active && " · inactive"}
          </span>
          <h1 className="text-2xl font-semibold tracking-tight text-balance">{vendor.name}</h1>
          <p className="text-sm text-ink-2">
            {thisYear.count === 0 ? (
              <>Nothing paid in FY {fy} yet</>
            ) : (
              <>
                Paid <span className="font-mono tabular-nums">{formatMinorUnits(thisYear.totalMinor)}</span> across {thisYear.count} request
                {thisYear.count === 1 ? "" : "s"} in FY {fy}
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!currentBank ? (
            <Pill tone="warn">No bank details</Pill>
          ) : currentBank.verifiedAt ? (
            <Pill tone="ok">Bank verified</Pill>
          ) : (
            <Pill tone="warn">Bank not yet verified</Pill>
          )}
          {canEdit && <VendorProfileForm vendor={vendor} heads={heads} />}
        </div>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <Section title="Identity & KYC">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px]">
            <Fact label="GSTIN" value={vendor.gstin} mono />
            <Fact label="PAN" value={vendor.pan} mono />
            <Fact label="MSME / Udyam" value={vendor.udyam} mono />
            <Fact label="TDS section" value={tdsRateLabel(vendor.tdsSection)} />
            <Fact label="Address" value={vendor.registeredAddress} />
          </dl>
        </Section>

        <Section title={live ? `Bank · version ${live.version}` : "Bank"}>
          {live ? (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px]">
              <Fact label="Beneficiary" value={live.beneficiaryName} />
              <Fact label="Account" value={`••••••${live.accountNumberLast4}`} mono />
              <Fact label="IFSC" value={live.ifsc} mono />
              <Fact label="Branch" value={live.branch} />
              <Fact label="Effective from" value={live.effectiveFrom} mono />
              <Fact label="Entered by" value={live.enteredByName ? `${live.enteredByName} (${live.enteredAsRole})` : live.enteredAsRole} />
              <Fact
                label="Verified"
                value={live.verifiedAt ? `${live.verifiedByName ?? "a payer"}, ${onDate(live.verifiedAt)}` : null}
              />
            </dl>
          ) : (
            <p className="text-[13px] text-ink-2">No bank details on file. The payer can&apos;t pay this vendor until they&apos;re added and verified.</p>
          )}
          {past.length > 0 && (
            <details className="text-[12.5px]">
              <summary className="cursor-pointer text-accent">
                {past.length} earlier version{past.length === 1 ? "" : "s"}
              </summary>
              <ul className="mt-2 flex flex-col gap-1.5">
                {past.map((v) => (
                  <li key={v.id} className="rounded-lg bg-sunk px-2.5 py-1.5 text-ink-2">
                    <span className="font-semibold text-ink">v{v.version}</span> <span className="font-mono">••••{v.accountNumberLast4} · {v.ifsc}</span>
                    <span className="block">
                      Replaced {v.supersededAt ? onDate(v.supersededAt) : ""}
                      {v.replacedByName && <> by {v.replacedByName}</>}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {canEdit && <VendorBankForm vendorId={vendor.id} hasCurrent={!!live} />}
        </Section>

        <Section title="Contact & terms">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px]">
            <Fact label="Contact" value={vendor.contactName} />
            <Fact label="Phone" value={vendor.contactPhone} mono />
            <Fact label="Email" value={vendor.contactEmail} />
            <Fact label="Payment terms" value={vendor.paymentTermsDays != null ? `${vendor.paymentTermsDays} days` : null} />
            <Fact label="Default head" value={defaultHead?.name} />
          </dl>
        </Section>

        <Section title={`Documents · ${documentsWithUrls.length}`}>
          {documentsWithUrls.length === 0 ? (
            <p className="text-[13px] text-ink-2">No documents on file.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {documentsWithUrls.map((d) => (
                <li key={d.id}>
                  <a href={d.downloadUrl} target="_blank" rel="noreferrer" className="text-[13px] text-accent hover:underline">
                    {DOCUMENT_KIND_LABELS[d.kind] ?? d.kind} ↗
                  </a>
                </li>
              ))}
            </ul>
          )}
          {canEdit && <VendorDocumentUpload vendorId={vendor.id} />}
        </Section>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className={`${eyebrowClass} px-1`}>Payment history · {payments.length}</h2>
        {payments.length === 0 ? (
          <p className="rounded-xl border border-line-soft bg-surface p-4 text-[13px] text-ink-2">No payments recorded for this vendor yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-line text-left font-cond text-[11px] tracking-[0.07em] text-ink-3 uppercase">
                  <th className="px-3 py-2 font-semibold">Request</th>
                  <th className="px-3 py-2 font-semibold">Value date</th>
                  <th className="px-3 py-2 font-semibold">UTR</th>
                  <th className="px-3 py-2 text-right font-semibold">Amount</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.reference} className="border-b border-line-soft last:border-b-0">
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <Link href={`/requests/${p.requestId}`} className="font-mono text-accent hover:underline">
                        {p.requestRef}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 font-mono whitespace-nowrap">{p.valueDate}</td>
                    <td className="px-3 py-2.5 font-mono whitespace-nowrap">{p.reference}</td>
                    <td className="px-3 py-2.5 text-right font-mono whitespace-nowrap tabular-nums">{formatMinorUnits(p.amountMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
