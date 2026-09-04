import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { verifySession } from "@/auth/dal";
import { withGrantScope } from "@/db/runtime";
import { headOfAccount } from "@/db/schema";
import { formatMinorUnits } from "@/lib/money";
import { presignGetUrl } from "@/storage/r2";
import { tdsRateLabel } from "@/vendors/tds";
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

  const [defaultHead] = vendor.defaultHeadId
    ? await withGrantScope(session.userId, role, (tx) => tx.select().from(headOfAccount).where(eq(headOfAccount.id, vendor.defaultHeadId!)).limit(1))
    : [null];

  const payments = await listVendorPaymentHistory(session.userId, role, id);

  const documentsWithUrls = await Promise.all(documents.map(async (d) => ({ ...d, downloadUrl: await presignGetUrl(d.storageKey) })));

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8">
      <div>
        <h1 className="text-2xl font-semibold">{vendor.name}</h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          {vendor.type ?? "Vendor"}
          {!vendor.active && " · inactive"}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <section className="flex flex-col gap-2 rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <h2 className="text-sm font-medium">Identity &amp; KYC</h2>
          <dl className="flex flex-col gap-1 text-sm">
            <div className="flex justify-between gap-2">
              <dt className="text-zinc-500">GSTIN</dt>
              <dd className="font-mono">{vendor.gstin ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-zinc-500">PAN</dt>
              <dd className="font-mono">{vendor.pan ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-zinc-500">MSME / Udyam</dt>
              <dd className="font-mono">{vendor.udyam ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-zinc-500">TDS section</dt>
              <dd>{tdsRateLabel(vendor.tdsSection) ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-zinc-500">Address</dt>
              <dd className="text-right">{vendor.registeredAddress ?? "—"}</dd>
            </div>
          </dl>
        </section>

        <section className="flex flex-col gap-2 rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium">Bank</h2>
            {currentBank && (
              <span className={currentBank.verifiedAt ? "text-xs text-green-600 dark:text-green-400" : "text-xs text-amber-600 dark:text-amber-400"}>
                {currentBank.verifiedAt ? "Verified" : "Not yet verified"}
              </span>
            )}
          </div>
          {currentBank ? (
            <dl className="flex flex-col gap-1 text-sm">
              <div className="flex justify-between gap-2">
                <dt className="text-zinc-500">Beneficiary</dt>
                <dd>{currentBank.beneficiaryName}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-zinc-500">Account</dt>
                <dd className="font-mono">••••••{currentBank.accountNumberLast4}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-zinc-500">IFSC</dt>
                <dd className="font-mono">{currentBank.ifsc}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-zinc-500">Branch</dt>
                <dd>{currentBank.branch ?? "—"}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">No bank details on file yet.</p>
          )}
          {canEdit && <VendorBankForm vendorId={vendor.id} />}
        </section>

        <section className="flex flex-col gap-2 rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <h2 className="text-sm font-medium">Contact &amp; terms</h2>
          <dl className="flex flex-col gap-1 text-sm">
            <div className="flex justify-between gap-2">
              <dt className="text-zinc-500">Contact</dt>
              <dd>{vendor.contactName ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-zinc-500">Phone</dt>
              <dd className="font-mono">{vendor.contactPhone ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-zinc-500">Email</dt>
              <dd>{vendor.contactEmail ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-zinc-500">Payment terms</dt>
              <dd>{vendor.paymentTermsDays != null ? `${vendor.paymentTermsDays} days` : "—"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-zinc-500">Default head</dt>
              <dd>{defaultHead?.name ?? "—"}</dd>
            </div>
          </dl>
        </section>

        <section className="flex flex-col gap-2 rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <h2 className="text-sm font-medium">Documents</h2>
          {documentsWithUrls.length === 0 ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">No documents on file yet.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {documentsWithUrls.map((d) => (
                <li key={d.id} className="text-sm">
                  <a href={d.downloadUrl} target="_blank" rel="noreferrer" className="underline">
                    {DOCUMENT_KIND_LABELS[d.kind] ?? d.kind}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {canEdit && <VendorDocumentUpload vendorId={vendor.id} />}
        </section>
      </div>

      {canEdit && editRole && <VendorProfileForm vendor={vendor} heads={await fetchHeads(session.userId, editRole)} />}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Payment history</h2>
        {payments.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">No payments recorded for this vendor yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {payments.map((p) => (
              <li key={p.reference} className="text-sm">
                <Link href={`/requests/${p.requestId}`} className="underline">
                  {p.requestRef}
                </Link>{" "}
                · {formatMinorUnits(p.amountMinor)} · {p.valueDate} · UTR {p.reference}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

async function fetchHeads(userId: string, role: "accountant" | "super_admin") {
  return withGrantScope(userId, role, (tx) => tx.select().from(headOfAccount).where(eq(headOfAccount.active, true)));
}
