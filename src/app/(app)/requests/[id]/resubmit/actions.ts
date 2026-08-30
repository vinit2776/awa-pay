"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { verifySession } from "@/auth/dal";
import { parseAmountToMinor } from "@/lib/money";
import { resubmit, type ResubmitResult } from "@/requests/resubmitCore";
import type { ResubmitAttachment } from "@/requests/transitions";
import { mintUploadSlot, type UploadSlotResult } from "@/storage/uploadSlot";

async function getClientMeta(): Promise<{ ip: string; userAgent: string | undefined }> {
  const h = await headers();
  const forwardedFor = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwardedFor || h.get("x-real-ip") || "unknown";
  return { ip, userAgent: h.get("user-agent") ?? undefined };
}

export async function requestResubmitUploadSlot(mime: string): Promise<UploadSlotResult> {
  await verifySession();
  return mintUploadSlot(mime);
}

export async function resubmitAction(
  requestId: string,
  input: {
    amount: string;
    invoiceNo: string;
    invoiceDate: string;
    vendor: string;
    note: string;
    newAttachments: ResubmitAttachment[];
  },
): Promise<ResubmitResult> {
  const session = await verifySession();
  const { ip, userAgent } = await getClientMeta();

  const amountMinor = parseAmountToMinor(input.amount);
  if (amountMinor === null) {
    return { ok: false, error: "Enter a valid amount." };
  }

  const result = await resubmit({
    userId: session.userId,
    requestId,
    ip,
    userAgent,
    amountMinor,
    invoiceNo: input.invoiceNo || undefined,
    invoiceDate: input.invoiceDate || undefined,
    vendor: input.vendor || undefined,
    note: input.note || undefined,
    newAttachments: input.newAttachments,
  });

  if (result.ok) {
    revalidatePath(`/requests/${requestId}`);
  }
  return result;
}
