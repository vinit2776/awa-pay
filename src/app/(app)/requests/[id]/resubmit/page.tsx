import { notFound } from "next/navigation";
import { verifySession } from "@/auth/dal";
import { resolveViewerRole } from "@/requests/viewerRole";
import { ResubmitForm } from "./ResubmitForm";

export default async function ResubmitPage({ params }: PageProps<"/requests/[id]/resubmit">) {
  const { id } = await params;
  const session = await verifySession();

  const resolved = await resolveViewerRole(session.userId, id);
  if (!resolved || resolved.role !== "requester" || resolved.request.stage !== "raised") {
    notFound();
  }
  const { request: req } = resolved;

  return (
    <div className="flex flex-1 flex-col items-center gap-6 px-4 py-8">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">{req.ref} — returned to you</h1>
        {req.closeReason && <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{req.closeReason}</p>}
      </div>
      <ResubmitForm
        requestId={req.id}
        initialAmount={(req.amountMinor / 100).toFixed(2)}
        initialVendor={req.vendor ?? ""}
        initialInvoiceNo={req.invoiceNo ?? ""}
        initialInvoiceDate={req.invoiceDate ?? ""}
        initialNote={req.note ?? ""}
      />
    </div>
  );
}
