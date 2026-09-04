"use server";

import { headers } from "next/headers";
import { verifySession } from "@/auth/dal";
import { parseAmountToMinor } from "@/lib/money";
import { submitRequest as submitRequestCore, type Attachment } from "@/requests/captureCore";
import { mintUploadSlot, type UploadSlotResult } from "@/storage/uploadSlot";

async function getClientMeta(): Promise<{ ip: string; userAgent: string | undefined }> {
  const h = await headers();
  const forwardedFor = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwardedFor || h.get("x-real-ip") || "unknown";
  return { ip, userAgent: h.get("user-agent") ?? undefined };
}

export type { UploadSlotResult };

export async function requestUploadSlot(mime: string): Promise<UploadSlotResult> {
  await verifySession();
  return mintUploadSlot("bills", mime);
}

export type SubmitFormState = { ok: true; ref: string } | { ok: false; error: string } | undefined;

export async function submitRequestAction(input: {
  departmentId: string;
  amount: string;
  invoiceNo: string;
  invoiceDate: string;
  vendor: string;
  note: string;
  attachments: Attachment[];
}): Promise<SubmitFormState> {
  const session = await verifySession();
  const { ip, userAgent } = await getClientMeta();

  const amountMinor = parseAmountToMinor(input.amount);
  if (amountMinor === null) {
    return { ok: false, error: "Enter a valid amount." };
  }

  const result = await submitRequestCore({
    userId: session.userId,
    ip,
    userAgent,
    departmentId: input.departmentId,
    amountMinor,
    invoiceNo: input.invoiceNo || undefined,
    invoiceDate: input.invoiceDate || undefined,
    vendor: input.vendor || undefined,
    note: input.note || undefined,
    attachments: input.attachments,
  });

  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true, ref: result.ref };
}
