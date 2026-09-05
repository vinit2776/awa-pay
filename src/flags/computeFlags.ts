import { and, desc, inArray, isNull } from "drizzle-orm";
import type { ScopedTx } from "@/db/runtime";
import { accounting, department, query, request, vendorBank } from "@/db/schema";

// "Flags are computed, not set by hand" (concept-v2.html §07): ageing past
// the department's threshold, an unanswered query, a due date within 48
// hours, a repeat amount for the same vendor in the same month, a vendor
// whose bank details changed since the last payment. Every one of these
// (bar dueDate itself, cached on request — see request.ts) is computed
// fresh here, never stored, so a flag can never go stale independently of
// the row it describes.
export type FlagKey = "ageing" | "unanswered_query" | "due_soon" | "repeat_amount" | "bank_changed";
export type Flag = { key: FlagKey; severity: "red" | "amber"; reason: string };

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Held requests are deliberately excluded — "otherwise the queue turns red
// for something deliberately parked" (concept-v2.html §04) — as are the
// three terminal stages, which are no longer waiting on anyone.
const AGEING_EXEMPT_STAGES = new Set(["on_hold", "paid", "rejected", "withdrawn"]);

export type RequestForFlags = {
  id: string;
  stage: string;
  departmentId: string;
  createdAt: Date;
  dueDate: string | null;
  vendorKey: string | null;
  amountMinor: number;
  invoiceDate: string | null;
};

export type FlagContext = {
  now: Date;
  ageingThresholdByDept: Map<string, number>;
  openQueryRequestIds: Set<string>;
  repeatAmountRequestIds: Set<string>;
  bankChangedRequestIds: Set<string>;
};

// Pure: no I/O, so every flag decision is directly testable against
// hand-built fixtures without a database round trip. All the actual
// lookups live in loadFlagContext below, batched once per page load
// rather than once per row.
export function computeFlags(req: RequestForFlags, ctx: FlagContext): Flag[] {
  const flags: Flag[] = [];

  if (!AGEING_EXEMPT_STAGES.has(req.stage)) {
    const threshold = ctx.ageingThresholdByDept.get(req.departmentId);
    if (threshold != null) {
      const days = Math.floor((ctx.now.getTime() - req.createdAt.getTime()) / MS_PER_DAY);
      if (days > threshold) {
        flags.push({ key: "ageing", severity: "red", reason: `Waiting ${days} days — past this department's ${threshold}-day threshold` });
      }
    }
  }

  if (ctx.openQueryRequestIds.has(req.id)) {
    flags.push({ key: "unanswered_query", severity: "amber", reason: "An open query is awaiting an answer" });
  }

  // Only meaningful once the payer actually owns the bill — a stale due
  // date left over from before a return-to-approver/accounts round trip
  // never gets here because returnRequestToRequester clears it and no
  // other transition sets stage to to_pay without accountRequest running
  // in between.
  if (req.stage === "to_pay" && req.dueDate) {
    const dueMs = Date.parse(`${req.dueDate}T00:00:00.000Z`);
    const daysUntil = Math.ceil((dueMs - ctx.now.getTime()) / MS_PER_DAY);
    if (daysUntil <= 2) {
      flags.push(
        daysUntil < 0
          ? { key: "due_soon", severity: "red", reason: `${Math.abs(daysUntil)} day${Math.abs(daysUntil) === 1 ? "" : "s"} overdue` }
          : { key: "due_soon", severity: "amber", reason: daysUntil === 0 ? "Due today" : `Due in ${daysUntil} day${daysUntil === 1 ? "" : "s"}` },
      );
    }
  }

  if (ctx.repeatAmountRequestIds.has(req.id)) {
    flags.push({ key: "repeat_amount", severity: "amber", reason: "Same vendor, same amount, billed again this month" });
  }

  if (ctx.bankChangedRequestIds.has(req.id)) {
    flags.push({ key: "bank_changed", severity: "red", reason: "This vendor's bank details haven't been verified since they were last entered or changed" });
  }

  return flags;
}

// Batched once per page load across every row the caller is about to
// render — never per row, which is exactly the N+1 pattern request.dueDate
// itself was added to avoid for the one field cheap enough to cache.
export async function loadFlagContext(tx: ScopedTx, rows: RequestForFlags[], now: Date = new Date()): Promise<FlagContext> {
  const empty: FlagContext = {
    now,
    ageingThresholdByDept: new Map(),
    openQueryRequestIds: new Set(),
    repeatAmountRequestIds: new Set(),
    bankChangedRequestIds: new Set(),
  };
  if (rows.length === 0) return empty;

  const requestIds = rows.map((r) => r.id);
  const deptIds = [...new Set(rows.map((r) => r.departmentId))];

  const depts = await tx.select({ id: department.id, ageingThresholdDays: department.ageingThresholdDays }).from(department).where(inArray(department.id, deptIds));
  const ageingThresholdByDept = new Map(depts.map((d) => [d.id, d.ageingThresholdDays]));

  const openQueryRows = await tx
    .select({ requestId: query.requestId })
    .from(query)
    .where(and(inArray(query.requestId, requestIds), isNull(query.resolvedAt)));
  const openQueryRequestIds = new Set(openQueryRows.map((q) => q.requestId));

  // Repeat vendor amount, same calendar month: only requests that have
  // reached accounting ever have vendorKey set, so this naturally never
  // matches a rejected/withdrawn request (both are pre-account stages).
  const vendorKeys = [...new Set(rows.filter((r) => r.vendorKey).map((r) => r.vendorKey as string))];
  const repeatAmountRequestIds = new Set<string>();
  if (vendorKeys.length > 0) {
    const siblings = await tx
      .select({ id: request.id, vendorKey: request.vendorKey, amountMinor: request.amountMinor, invoiceDate: request.invoiceDate })
      .from(request)
      .where(inArray(request.vendorKey, vendorKeys));
    const bucket = new Map<string, number>();
    for (const s of siblings) {
      if (!s.invoiceDate) continue;
      const bucketKey = `${s.vendorKey}|${s.amountMinor}|${s.invoiceDate.slice(0, 7)}`;
      bucket.set(bucketKey, (bucket.get(bucketKey) ?? 0) + 1);
    }
    for (const row of rows) {
      if (!row.vendorKey || !row.invoiceDate) continue;
      const bucketKey = `${row.vendorKey}|${row.amountMinor}|${row.invoiceDate.slice(0, 7)}`;
      if ((bucket.get(bucketKey) ?? 0) > 1) repeatAmountRequestIds.add(row.id);
    }
  }

  // Vendor bank changed (or never verified): resolve each accounted,
  // still-open request's latest vendor, then check whether that vendor's
  // CURRENT bank row is unverified — the same live read
  // checkPaymentBankReadiness uses at pay time (src/vendors/verifyCore.ts),
  // surfaced here as a flag across every open desk instead of a hard block
  // at just one of them.
  const bankChangedRequestIds = new Set<string>();
  const accountedRequestIds = rows.filter((r) => r.vendorKey && (r.stage === "with_accounts" || r.stage === "to_pay")).map((r) => r.id);
  if (accountedRequestIds.length > 0) {
    const accountingRows = await tx
      .select({ requestId: accounting.requestId, vendorId: accounting.vendorId })
      .from(accounting)
      .where(inArray(accounting.requestId, accountedRequestIds))
      .orderBy(desc(accounting.accountedAt));
    const latestVendorByRequest = new Map<string, string>();
    for (const a of accountingRows) {
      if (!latestVendorByRequest.has(a.requestId)) latestVendorByRequest.set(a.requestId, a.vendorId);
    }
    const vendorIds = [...new Set(latestVendorByRequest.values())];
    if (vendorIds.length > 0) {
      const currentBanks = await tx
        .select({ vendorId: vendorBank.vendorId, verifiedAt: vendorBank.verifiedAt })
        .from(vendorBank)
        .where(and(inArray(vendorBank.vendorId, vendorIds), isNull(vendorBank.supersededAt)));
      const currentUnverifiedVendorIds = new Set(currentBanks.filter((b) => !b.verifiedAt).map((b) => b.vendorId));
      for (const [requestId, vendorId] of latestVendorByRequest) {
        if (currentUnverifiedVendorIds.has(vendorId)) bankChangedRequestIds.add(requestId);
      }
    }
  }

  return { now, ageingThresholdByDept, openQueryRequestIds, repeatAmountRequestIds, bankChangedRequestIds };
}
