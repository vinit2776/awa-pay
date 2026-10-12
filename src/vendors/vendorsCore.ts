import { and, desc, eq, ilike, inArray, isNull, or } from "drizzle-orm";
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

// What the accounts desk shows about a vendor's current bank record: enough
// to recognise it and know whether the payer still has to verify it. Never
// the full account number, which stays encrypted in vendor_bank.
export type VendorBankSummary = {
  beneficiaryName: string;
  accountNumberLast4: string;
  ifsc: string;
  branch: string | null;
  verified: boolean;
};

export type VendorSummary = { id: string; name: string; gstin: string | null; pan: string | null; bank: VendorBankSummary | null };

export type VendorBankInput = { beneficiaryName: string; accountNumber: string; ifsc: string; branch: string | null; effectiveFrom: string };

// One place for "is this a bank record we'd accept", shared by every path
// that writes one (the vendor page, vendor creation, the accounts desk).
function validateBank(bank: VendorBankInput): string | null {
  if (!bank.beneficiaryName.trim()) return "A beneficiary name is required.";
  if (!/^\d{4,20}$/.test(bank.accountNumber)) return "Enter a valid account number.";
  if (!bank.ifsc.trim()) return "An IFSC code is required.";
  return null;
}

// Supersede the vendor's current bank row, if any, and insert the new one.
// The new row is always unverified: verification is the payer's, against the
// bill. Caller holds the transaction and has already taken lockVendorMutex.
async function writeCurrentBank(tx: ScopedTx, actorId: string, vendorId: string, bank: VendorBankInput): Promise<void> {
  await tx
    .update(vendorBank)
    .set({ supersededAt: new Date() })
    .where(and(eq(vendorBank.vendorId, vendorId), isNull(vendorBank.supersededAt)));

  await tx.insert(vendorBank).values({
    vendorId,
    beneficiaryName: bank.beneficiaryName.trim(),
    accountNumberEncrypted: encryptSecret(bank.accountNumber),
    accountNumberLast4: bank.accountNumber.slice(-4),
    ifsc: bank.ifsc.trim().toUpperCase(),
    branch: bank.branch,
    effectiveFrom: bank.effectiveFrom,
    enteredBy: actorId,
    enteredAsRole: "accountant",
  });
}

// Matches by name (case-insensitive substring — what a human types from a
// bill) or an exact GSTIN/PAN hit (the identity fields the partial unique
// indexes on vendor actually enforce uniqueness on).
export async function searchVendors(actorId: string, role: Role, term: string): Promise<VendorSummary[]> {
  const trimmed = term.trim();
  if (!trimmed) return [];
  return withGrantScope(actorId, role, async (tx) => {
    const matches = await tx
      .select({ id: vendor.id, name: vendor.name, gstin: vendor.gstin, pan: vendor.pan })
      .from(vendor)
      .where(and(eq(vendor.active, true), or(ilike(vendor.name, `%${trimmed}%`), eq(vendor.gstin, trimmed), eq(vendor.pan, trimmed))))
      .orderBy(desc(vendor.createdAt))
      .limit(10);
    if (matches.length === 0) return [];

    // One batched lookup of each match's current bank, never one per row.
    const banks = await tx
      .select()
      .from(vendorBank)
      .where(and(inArray(vendorBank.vendorId, matches.map((m) => m.id)), isNull(vendorBank.supersededAt)));
    const bankByVendor = new Map(banks.map((b) => [b.vendorId, b]));

    return matches.map((m) => {
      const b = bankByVendor.get(m.id);
      return {
        ...m,
        bank: b
          ? { beneficiaryName: b.beneficiaryName, accountNumberLast4: b.accountNumberLast4, ifsc: b.ifsc, branch: b.branch, verified: b.verifiedAt !== null }
          : null,
      };
    });
  });
}

export type CreateVendorResult = { ok: true; id: string } | { ok: false; error: string };

// Role is caller-supplied, not hardcoded, because vendor_insert (0015)
// permits both accountant and super_admin — matching that exactly rather
// than silently narrowing it back down to one role.
export type VendorWriterRole = "accountant" | "super_admin";

// Minimal create: a name, an optional GSTIN-or-PAN, and optionally the bank
// details. Full KYC and documents happen on the vendor's own /vendors/[id]
// page, never inline here, so an accountant is never blocked mid-bill by a
// long form. requestId is the request being accounted when this vendor was
// created — always present in phase 9's only call site (AccountantPanel's
// inline create), and is what gives this event a home in that request's
// own trail.
export async function createVendor(
  actorId: string,
  role: VendorWriterRole,
  requestId: string,
  params: { name: string; gstin?: string | null; pan?: string | null; bank?: VendorBankInput | null },
  meta: Meta,
): Promise<CreateVendorResult> {
  if (!params.name.trim()) return { ok: false, error: "A vendor name is required." };
  // Bank details given at creation are validated up front so a bad account
  // number never leaves a vendor created without the bank the accountant
  // typed in: the vendor and its bank commit together or not at all.
  if (params.bank) {
    const bankError = validateBank(params.bank);
    if (bankError) return { ok: false, error: bankError };
  }

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
          // ONE event, bank included. appendEvent finds the chain's previous
          // link by ordering on event.at, and every event in a transaction
          // shares the transaction's timestamp, so a second event for the
          // same request in this transaction could pick the wrong
          // predecessor and fork the hash chain.
          after: {
            name: params.name.trim(),
            gstin: params.gstin || null,
            pan: params.pan || null,
            bank: params.bank ? bankSummaryForEvent(params.bank) : null,
          },
          reason: null,
        },
        meta,
      );

      if (params.bank) {
        await lockVendorMutex(tx, row.id);
        await writeCurrentBank(tx, actorId, row.id, params.bank);
      }

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
export async function setVendorBank(actorId: string, vendorId: string, params: VendorBankInput): Promise<SetVendorBankResult> {
  const bankError = validateBank(params);
  if (bankError) return { ok: false, error: bankError };

  return withGrantScope(actorId, "accountant", async (tx: ScopedTx) => {
    await lockVendorMutex(tx, vendorId);
    await writeCurrentBank(tx, actorId, vendorId, params);
    return { ok: true };
  });
}

function bankSummaryForEvent(bank: VendorBankInput) {
  return { ifsc: bank.ifsc.trim().toUpperCase(), accountNumberLast4: bank.accountNumber.slice(-4), beneficiaryName: bank.beneficiaryName.trim() };
}

function bankAddedEvent(requestId: string, actorId: string, vendorId: string, bank: VendorBankInput) {
  return {
    requestId,
    actor: actorId,
    roleAtTime: "accountant",
    type: "vendor.bank_added",
    objectType: "vendor",
    objectId: vendorId,
    before: {},
    after: bankSummaryForEvent(bank),
    reason: null,
  };
}

// The accounts desk's version of setVendorBank: the same supersede-and-insert,
// but made while accounting a specific request, so the change lands in that
// request's trail in the same transaction (AGENTS.md rule 3). The vendor page
// keeps calling setVendorBank, which has no request to attach an event to.
export async function addVendorBankForRequest(
  actorId: string,
  requestId: string,
  vendorId: string,
  params: VendorBankInput,
  meta: Meta,
): Promise<SetVendorBankResult> {
  const bankError = validateBank(params);
  if (bankError) return { ok: false, error: bankError };

  return withGrantScope(actorId, "accountant", async (tx: ScopedTx) => {
    await lockVendorMutex(tx, vendorId);
    const [req] = await tx.select({ id: request.id }).from(request).where(eq(request.id, requestId)).limit(1);
    if (!req) return { ok: false, error: "Request not found." };
    await writeCurrentBank(tx, actorId, vendorId, params);
    await appendEvent(tx, bankAddedEvent(requestId, actorId, vendorId, params), meta);
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
