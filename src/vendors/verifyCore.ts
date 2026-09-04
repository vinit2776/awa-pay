import { and, desc, eq, isNull } from "drizzle-orm";
import { withGrantScope } from "@/db/runtime";
import { accounting, vendor, vendorBank, vendorDocument } from "@/db/schema";
import { appendEvent, type Meta } from "@/events/append";
import { encryptSecret } from "./crypto";
import { lockVendorMutex } from "./lock";

// Pure orchestration, no next/headers — mirrors vendorsCore.ts's shape.
// Everything here is payer-scoped (0016_payer_verification_rls_and_grants.sql),
// the counterpart to vendorsCore.ts's accountant-scoped writes.

export type PaymentBankReadiness =
  | { ready: true }
  | { ready: false; reason: "no_vendor" }
  | { ready: false; reason: "no_bank"; vendorId: string; vendorName: string }
  | {
      ready: false;
      reason: "unverified";
      vendorId: string;
      vendorName: string;
      bank: { id: string; beneficiaryName: string; accountNumberLast4: string; ifsc: string; branch: string | null };
    };

// Resolves the vendor matched to this request via its latest accounting
// row, then checks that vendor's CURRENT bank row (superseded_at IS NULL)
// has been verified. This one live read — no per-request cached flag — is
// the entire mechanism behind "a bank change flags every open request for
// this vendor": the moment any vendor_bank row is superseded, the new
// row's verified_at starts null, so the very next payRequest attempt on
// ANY open request for that vendor re-triggers this gate automatically.
export async function checkPaymentBankReadiness(actorId: string, requestId: string): Promise<PaymentBankReadiness> {
  return withGrantScope(actorId, "payer", async (tx) => {
    const [acc] = await tx
      .select({ vendorId: accounting.vendorId })
      .from(accounting)
      .where(eq(accounting.requestId, requestId))
      .orderBy(desc(accounting.accountedAt))
      .limit(1);
    if (!acc) return { ready: false, reason: "no_vendor" };

    const [v] = await tx.select({ id: vendor.id, name: vendor.name }).from(vendor).where(eq(vendor.id, acc.vendorId)).limit(1);
    if (!v) return { ready: false, reason: "no_vendor" };

    const [bank] = await tx
      .select()
      .from(vendorBank)
      .where(and(eq(vendorBank.vendorId, v.id), isNull(vendorBank.supersededAt)))
      .limit(1);
    if (!bank) return { ready: false, reason: "no_bank", vendorId: v.id, vendorName: v.name };

    if (!bank.verifiedAt) {
      return {
        ready: false,
        reason: "unverified",
        vendorId: v.id,
        vendorName: v.name,
        bank: { id: bank.id, beneficiaryName: bank.beneficiaryName, accountNumberLast4: bank.accountNumberLast4, ifsc: bank.ifsc, branch: bank.branch },
      };
    }

    return { ready: true };
  });
}

export type VerifyVendorBankResult = { ok: true } | { ok: false; error: string };

// One-directional, matching vendor_bank_update_verify's own USING/WITH
// CHECK shape (0016): can only move an unverified row to verified,
// attributed to the actor doing the verifying — never the reverse, never
// on someone else's behalf. requestId ties the resulting event to the
// request the payer was trying to pay when they verified, the same
// pattern phase 9's vendor.created event uses (event.request_id is
// required for event_select's non-admin branch to grant visibility at
// all — a vendor-level change with no request context would be logged
// but invisible to the very payer/accountant who need to see it).
export async function verifyVendorBank(actorId: string, requestId: string, vendorBankId: string, meta: Meta): Promise<VerifyVendorBankResult> {
  return withGrantScope(actorId, "payer", async (tx) => {
    const [row] = await tx
      .update(vendorBank)
      .set({ verifiedBy: actorId, verifiedAt: new Date() })
      .where(and(eq(vendorBank.id, vendorBankId), isNull(vendorBank.verifiedAt)))
      .returning({ id: vendorBank.id, vendorId: vendorBank.vendorId, ifsc: vendorBank.ifsc, accountNumberLast4: vendorBank.accountNumberLast4 });

    if (!row) {
      return { ok: false, error: "This bank record could not be verified — it may already be verified or superseded." };
    }

    await appendEvent(
      tx,
      {
        requestId,
        actor: actorId,
        roleAtTime: "payer",
        type: "vendor.bank_verified",
        objectType: "vendor_bank",
        objectId: row.id,
        before: {},
        after: { ifsc: row.ifsc, accountNumberLast4: row.accountNumberLast4 },
        reason: null,
      },
      meta,
    );

    return { ok: true };
  });
}

export type InsertVendorBankAsPayerResult = { ok: true } | { ok: false; error: string };

// The payer's narrow escape hatch (docs/START-HERE-slice-3.md's "Design
// decisions" — finding #3): entering bank details directly when the
// payer is physically holding fresh proof, rather than routing back
// through accounts first. Always self-verified at insert — there is no
// unverified state to later approve, which is what keeps this from being
// a way to skip verification rather than a way to perform it immediately.
//
// The friendly pre-check (does this vendor have ANY document on file) is
// UX only, matching nudgesCore.ts's own precedent — vendor_bank_insert_payer
// (0016) is the real guarantee, re-checking the same EXISTS clause at the
// database layer regardless of what this pre-check found.
export async function insertVendorBankAsPayer(
  actorId: string,
  vendorId: string,
  params: { beneficiaryName: string; accountNumber: string; ifsc: string; branch: string | null; effectiveFrom: string },
): Promise<InsertVendorBankAsPayerResult> {
  if (!params.beneficiaryName.trim()) return { ok: false, error: "A beneficiary name is required." };
  if (!/^\d{4,20}$/.test(params.accountNumber)) return { ok: false, error: "Enter a valid account number." };
  if (!params.ifsc.trim()) return { ok: false, error: "An IFSC code is required." };

  return withGrantScope(actorId, "payer", async (tx) => {
    const [doc] = await tx.select({ id: vendorDocument.id }).from(vendorDocument).where(eq(vendorDocument.vendorId, vendorId)).limit(1);
    if (!doc) {
      return { ok: false, error: "This vendor has no documents on file — ask accounts to add KYC documents before entering bank details yourself." };
    }

    await lockVendorMutex(tx, vendorId);

    await tx
      .update(vendorBank)
      .set({ supersededAt: new Date() })
      .where(and(eq(vendorBank.vendorId, vendorId), isNull(vendorBank.supersededAt)));

    await tx.insert(vendorBank).values({
      vendorId,
      beneficiaryName: params.beneficiaryName.trim(),
      accountNumberEncrypted: encryptSecret(params.accountNumber),
      accountNumberLast4: params.accountNumber.slice(-4),
      ifsc: params.ifsc.trim().toUpperCase(),
      branch: params.branch,
      effectiveFrom: params.effectiveFrom,
      enteredBy: actorId,
      enteredAsRole: "payer",
      verifiedBy: actorId,
      verifiedAt: new Date(),
    });

    return { ok: true };
  });
}
