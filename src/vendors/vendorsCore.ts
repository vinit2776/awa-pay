import { and, desc, eq, ilike, isNull, or } from "drizzle-orm";
import { type Role, type ScopedTx, withGrantScope } from "@/db/runtime";
import { accounting, payment, request, vendor, vendorBank, vendorDocument } from "@/db/schema";
import { appendEvent, type Meta } from "@/events/append";
import { headObjectContentLength } from "@/storage/r2";
import { encryptSecret } from "./crypto";
import { lockVendorMutex } from "./lock";

// Pure orchestration, no next/headers — mirrors queriesCore.ts/nudgesCore.ts's
// shape. Vendor data is role-scoped, not request-scoped (see
// drizzle/migrations/0015_vendor_rls_and_grants.sql), so every function
// here takes the caller's role directly rather than resolving it from a
// request.

// src/conversation/nudgesCore.ts found that drizzle-orm's postgres-js
// driver wraps the raw postgres.js error (which carries `.code` directly)
// in its own error class whose own top-level properties are just
// { query, params, cause }, with the code one level down at
// `err.cause.code`. Empirically, for an INSERT chained with `.returning()`
// (as every write in this file is), the error observed here is the raw,
// unwrapped postgres.js error instead — `.code` directly on `err`. Check
// both shapes rather than assume which one a given query style produces.
const UNIQUE_VIOLATION = "23505";
function isUniqueViolation(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === UNIQUE_VIOLATION) {
    return true;
  }
  const cause = err && typeof err === "object" && "cause" in err ? (err as { cause?: unknown }).cause : null;
  return Boolean(cause && typeof cause === "object" && "code" in cause && (cause as { code?: unknown }).code === UNIQUE_VIOLATION);
}

export type VendorSummary = { id: string; name: string; gstin: string | null; pan: string | null };

// Matches by name (case-insensitive substring — what a human types from a
// bill) or an exact GSTIN/PAN hit (the identity fields the partial unique
// indexes on vendor actually enforce uniqueness on).
export async function searchVendors(actorId: string, role: Role, term: string): Promise<VendorSummary[]> {
  const trimmed = term.trim();
  if (!trimmed) return [];
  return withGrantScope(actorId, role, (tx) =>
    tx
      .select({ id: vendor.id, name: vendor.name, gstin: vendor.gstin, pan: vendor.pan })
      .from(vendor)
      .where(and(eq(vendor.active, true), or(ilike(vendor.name, `%${trimmed}%`), eq(vendor.gstin, trimmed), eq(vendor.pan, trimmed))))
      .orderBy(desc(vendor.createdAt))
      .limit(10),
  );
}

export type CreateVendorResult = { ok: true; id: string } | { ok: false; error: string };

// Role is caller-supplied, not hardcoded, because vendor_insert (0015)
// permits both accountant and super_admin — matching that exactly rather
// than silently narrowing it back down to one role.
export type VendorWriterRole = "accountant" | "super_admin";

// Minimal create: a name and an optional GSTIN-or-PAN. Full KYC, bank
// details and documents happen on the vendor's own /vendors/[id] page —
// never inline here, so an accountant is never blocked mid-bill by a long
// form. requestId is the request being accounted when this vendor was
// created — always present in phase 9's only call site (AccountantPanel's
// inline create), and is what gives this event a home in that request's
// own trail.
export async function createVendor(
  actorId: string,
  role: VendorWriterRole,
  requestId: string,
  params: { name: string; gstin?: string | null; pan?: string | null },
  meta: Meta,
): Promise<CreateVendorResult> {
  if (!params.name.trim()) return { ok: false, error: "A vendor name is required." };

  // The try/catch wraps the whole transaction, not just the INSERT
  // statement inside it — postgres.js tracks a failed query's error
  // independently of whether the callback's own code caught and handled
  // it, and re-throws it once the transaction scope resolves (see
  // node_modules/postgres/src/index.js's `scope()`: `if (uncaughtError)
  // throw uncaughtError`). A try/catch *inside* the callback around just
  // the INSERT can observe and handle the error, but the transaction is
  // still aborted at the database level underneath it — any further
  // statement in that same transaction (the appendEvent call below) would
  // itself fail, and postgres.js re-surfaces the original error past the
  // callback's own "successful" return regardless. Catching around the
  // whole withGrantScope call is what actually lets a caught unique
  // violation here return gracefully instead of the transaction being
  // silently doomed either way.
  try {
    return await withGrantScope(actorId, role, async (tx) => {
      const [row] = await tx
        .insert(vendor)
        .values({ name: params.name.trim(), gstin: params.gstin || null, pan: params.pan || null, createdBy: actorId })
        .returning({ id: vendor.id });

      await appendEvent(
        tx,
        {
          requestId,
          actor: actorId,
          roleAtTime: role,
          type: "vendor.created",
          objectType: "vendor",
          objectId: row.id,
          before: {},
          after: { name: params.name.trim(), gstin: params.gstin || null, pan: params.pan || null },
          reason: null,
        },
        meta,
      );

      return { ok: true, id: row.id };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, error: "A vendor with this GSTIN or PAN already exists — search for it instead." };
    }
    throw err;
  }
}

export type UpdateVendorProfileResult = { ok: true } | { ok: false; error: string };

export type VendorProfileInput = {
  name: string;
  type: string | null;
  gstin: string | null;
  pan: string | null;
  udyam: string | null;
  tdsSection: string | null;
  registeredAddress: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  paymentTermsDays: number | null;
  defaultHeadId: string | null;
};

export async function updateVendorProfile(
  actorId: string,
  role: VendorWriterRole,
  vendorId: string,
  input: VendorProfileInput,
): Promise<UpdateVendorProfileResult> {
  if (!input.name.trim()) return { ok: false, error: "A vendor name is required." };

  try {
    await withGrantScope(actorId, role, (tx) =>
      tx
        .update(vendor)
        .set({ ...input, name: input.name.trim(), updatedAt: new Date() })
        .where(eq(vendor.id, vendorId)),
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, error: "Another vendor already has this GSTIN or PAN." };
    }
    throw err;
  }
  return { ok: true };
}

export type VendorDetail = typeof vendor.$inferSelect;
export type VendorBankRow = typeof vendorBank.$inferSelect;
export type VendorDocumentRow = typeof vendorDocument.$inferSelect;

export async function getVendor(
  actorId: string,
  role: Role,
  vendorId: string,
): Promise<{ vendor: VendorDetail; currentBank: VendorBankRow | null; documents: VendorDocumentRow[] } | null> {
  return withGrantScope(actorId, role, async (tx) => {
    const [row] = await tx.select().from(vendor).where(eq(vendor.id, vendorId)).limit(1);
    if (!row) return null;
    const [currentBank] = await tx
      .select()
      .from(vendorBank)
      .where(and(eq(vendorBank.vendorId, vendorId), isNull(vendorBank.supersededAt)))
      .limit(1);
    const documents = await tx.select().from(vendorDocument).where(eq(vendorDocument.vendorId, vendorId)).orderBy(desc(vendorDocument.createdAt));
    return { vendor: row, currentBank: currentBank ?? null, documents };
  });
}

export type SetVendorBankResult = { ok: true } | { ok: false; error: string };

// Supersede-then-insert, guarded by lockVendorMutex so two concurrent
// accountants can't both insert a "current" row for the same vendor —
// mirrors src/requests/transitions.ts's own runTransition shape (lock,
// then read, then write) but against src/vendors/lock.ts's own lock
// domain instead.
//
// No appendEvent call here, deliberately: event.request_id is required for
// event_select's non-admin branch to grant visibility at all
// (drizzle/migrations/0001_rls_and_grants.sql) — a vendor-level change
// isn't tied to any one request, so a null-request_id row would be
// logged but invisible to the accountant/payer who need to see it. The
// vendor_bank row itself is already the complete, immutable audit record
// (entered_by, effective_from, superseded_at), matching how vendor_bank
// is described in the brief (concept-v2.html §15) — no separate event
// row duplicates it.
export async function setVendorBank(
  actorId: string,
  vendorId: string,
  params: { beneficiaryName: string; accountNumber: string; ifsc: string; branch: string | null; effectiveFrom: string },
): Promise<SetVendorBankResult> {
  if (!params.beneficiaryName.trim()) return { ok: false, error: "A beneficiary name is required." };
  if (!/^\d{4,20}$/.test(params.accountNumber)) return { ok: false, error: "Enter a valid account number." };
  if (!params.ifsc.trim()) return { ok: false, error: "An IFSC code is required." };

  return withGrantScope(actorId, "accountant", async (tx: ScopedTx) => {
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
      enteredAsRole: "accountant",
    });

    return { ok: true };
  });
}

export type VendorPaymentHistoryRow = {
  requestRef: string;
  requestId: string;
  amountMinor: number;
  reference: string;
  valueDate: string;
};

// Scoped by the caller's own department/company grants transitively — via
// the same request/accounting/payment RLS policies every other query in
// this app already goes through (0006_desks_rls_and_grants.sql). No new
// SECURITY DEFINER function needed here: unlike phase 11's cross-department
// duplicate check, a vendor's payment history is only ever shown to
// someone who can already see those requests.
export async function listVendorPaymentHistory(actorId: string, role: Role, vendorId: string): Promise<VendorPaymentHistoryRow[]> {
  return withGrantScope(actorId, role, (tx) =>
    tx
      .select({
        requestRef: request.ref,
        requestId: request.id,
        amountMinor: payment.amountMinor,
        reference: payment.reference,
        valueDate: payment.valueDate,
      })
      .from(payment)
      .innerJoin(request, eq(request.id, payment.requestId))
      .innerJoin(accounting, eq(accounting.requestId, request.id))
      .where(eq(accounting.vendorId, vendorId))
      .orderBy(desc(payment.paidAt)),
  );
}

export type AddVendorDocumentResult = { ok: true; id: string } | { ok: false; error: string };

export async function addVendorDocument(
  actorId: string,
  role: VendorWriterRole,
  vendorId: string,
  params: { kind: (typeof vendorDocument.$inferInsert)["kind"]; storageKey: string; mime: string; byteLength: number; sha256: string },
): Promise<AddVendorDocumentResult> {
  // Same server-side corroboration captureCore.ts uses for a bill's
  // attachment — before opening any transaction, not after.
  const actualLength = await headObjectContentLength(params.storageKey);
  if (actualLength === null || actualLength !== params.byteLength) {
    return { ok: false, error: "The document could not be verified. Please try again." };
  }

  return withGrantScope(actorId, role, async (tx) => {
    const [row] = await tx
      .insert(vendorDocument)
      .values({
        vendorId,
        kind: params.kind,
        storageKey: params.storageKey,
        mime: params.mime,
        bytes: params.byteLength,
        sha256: params.sha256,
        uploadedBy: actorId,
      })
      .returning({ id: vendorDocument.id });
    return { ok: true, id: row.id };
  });
}
