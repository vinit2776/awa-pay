"use server";

import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { verifySession } from "@/auth/dal";
import { parseAmountToMinor } from "@/lib/money";
import { submitRequest as submitRequestCore, type Attachment } from "@/requests/captureCore";
import { ALLOWED_MIME_TYPES, buildStorageKey } from "@/storage/storageKey";
import { presignPutUrl } from "@/storage/r2";

async function getClientMeta(): Promise<{ ip: string; userAgent: string | undefined }> {
  const h = await headers();
  const forwardedFor = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwardedFor || h.get("x-real-ip") || "unknown";
  return { ip, userAgent: h.get("user-agent") ?? undefined };
}

export type UploadSlotResult =
  | { ok: true; fileId: string; storageKey: string; uploadUrl: string }
  | { ok: false; error: string };

export async function requestUploadSlot(mime: string): Promise<UploadSlotResult> {
  await verifySession();

  if (!ALLOWED_MIME_TYPES.includes(mime)) {
    return { ok: false, error: `Unsupported file type "${mime}".` };
  }

  const fileId = randomUUID();
  const storageKey = buildStorageKey(fileId, mime);
  const uploadUrl = await presignPutUrl(storageKey, mime);

  return { ok: true, fileId, storageKey, uploadUrl };
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
