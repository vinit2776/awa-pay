"use server";

import { revalidatePath } from "next/cache";
import { verifySession } from "@/auth/dal";
import { mintUploadSlot, type UploadSlotResult } from "@/storage/uploadSlot";
import {
  addVendorDocument,
  setVendorBank,
  updateVendorProfile,
  type AddVendorDocumentResult,
  type SetVendorBankResult,
  type UpdateVendorProfileResult,
  type VendorProfileInput,
} from "@/vendors/vendorsCore";
import { resolveVendorWriterRole } from "@/vendors/viewerRole";
import type { vendorDocument } from "@/db/schema";

export async function requestVendorDocumentUploadSlot(mime: string): Promise<UploadSlotResult> {
  await verifySession();
  return mintUploadSlot("vendor-documents", mime);
}

export async function updateVendorProfileAction(vendorId: string, input: VendorProfileInput): Promise<UpdateVendorProfileResult> {
  const session = await verifySession();
  const role = await resolveVendorWriterRole(session.userId);
  if (!role) return { ok: false, error: "You don't have permission to edit vendors." };
  const result = await updateVendorProfile(session.userId, role, vendorId, input);
  if (result.ok) revalidatePath(`/vendors/${vendorId}`);
  return result;
}

export async function setVendorBankAction(
  vendorId: string,
  input: { beneficiaryName: string; accountNumber: string; ifsc: string; branch: string | null; effectiveFrom: string },
): Promise<SetVendorBankResult> {
  const session = await verifySession();
  const result = await setVendorBank(session.userId, vendorId, input);
  if (result.ok) revalidatePath(`/vendors/${vendorId}`);
  return result;
}

export async function addVendorDocumentAction(
  vendorId: string,
  input: { kind: (typeof vendorDocument.$inferInsert)["kind"]; storageKey: string; mime: string; byteLength: number; sha256: string },
): Promise<AddVendorDocumentResult> {
  const session = await verifySession();
  const role = await resolveVendorWriterRole(session.userId);
  if (!role) return { ok: false, error: "You don't have permission to upload vendor documents." };
  const result = await addVendorDocument(session.userId, role, vendorId, input);
  if (result.ok) revalidatePath(`/vendors/${vendorId}`);
  return result;
}
