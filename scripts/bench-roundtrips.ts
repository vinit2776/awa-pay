// Round-trip benchmark for the app's hot paths. Run against the dev database:
//
//   npx tsx scripts/bench-roundtrips.ts
//
// Why this exists: from a laptop the Supabase pooler in ap-south-1 costs
// 0.3-2 s per round trip, so wall-clock time on any path is ~= (number of
// sequential round trips) x (latency). This counts the former directly.
//
// How it counts: postgres.js's `debug` hook fires for every statement it
// writes to the socket. It is injected by patching the `postgres` module
// before src/db/runtime.ts loads, so the code under test is unmodified.
// Statements written back-to-back on one connection (within FLIGHT_GAP_MS
// of each other) share a network flight. A statement with bind parameters
// costs one extra round trip (postgres.js under `prepare: false` must
// Describe it before it can Bind/Execute), and cannot be pipelined. So
//   statements = statements sent
//   rtts       = estimated sequential round trips on the wire
// `rtts` is summed across connections, so a path that runs two transactions
// in parallel reports both; `wall` is the real elapsed time.
//
// Fixtures are created and removed through the owner connection (same as
// tests/*.test.ts). Never imported by application code.
import { randomUUID } from "node:crypto";
import { config } from "dotenv";

config({ path: ".env.local" });

const FLIGHT_GAP_MS = 25;

type Sent = { t: number; conn: number; sql: string; params: number };
let sent: Sent[] = [];

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realPostgres = require("postgres");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const patched: any = (url: string, options: Record<string, unknown> = {}) =>
  realPostgres(url, {
    ...options,
    debug: (conn: number, query: string, params: unknown[]) =>
      sent.push({ t: performance.now(), conn, sql: query.replace(/\s+/g, " ").slice(0, 70), params: params?.length ?? 0 }),
  });
Object.assign(patched, realPostgres);
patched.default = patched;
require.cache[require.resolve("postgres")]!.exports = patched;

function flightsOf(events: Sent[]): number {
  const byConn = new Map<number, Sent[]>();
  for (const e of events) byConn.set(e.conn, [...(byConn.get(e.conn) ?? []), e]);
  let flights = 0;
  for (const list of byConn.values()) {
    list.sort((a, b) => a.t - b.t);
    let last = -Infinity;
    for (const e of list) {
      if (e.t - last > FLIGHT_GAP_MS) flights++;
      if (e.params > 0) flights++; // the Bind/Execute half, after the Describe reply
      last = e.t;
    }
  }
  return flights;
}

type Row = { label: string; statements: number; flights: number; wallMs: number };
const rows: Row[] = [];

async function measure<T>(label: string, fn: () => Promise<T>): Promise<T> {
  sent = [];
  const t0 = performance.now();
  const result = await fn();
  const wallMs = performance.now() - t0;
  const row = { label, statements: sent.length, flights: flightsOf(sent), wallMs };
  rows.push(row);
  console.log(`${label.padEnd(58)} statements=${String(row.statements).padStart(3)} rtts=${String(row.flights).padStart(3)} wall=${(wallMs / 1000).toFixed(1)}s`);
  if (process.env.BENCH_VERBOSE) for (const e of sent) console.log(`    conn${e.conn} +${(e.t - sent[0].t).toFixed(0)}ms ${e.sql}`);
  return result;
}

async function main() {
  const { closeOwnerConnection, dbOwner } = await import("./db-owner");
  const rt = await import("../src/db/runtime");
  const s = await import("../src/db/schema");
  const { hashSecret } = await import("../src/auth/password");
  const { attemptLogin } = await import("../src/auth/loginCore");
  const store = await import("../src/auth/sessionStore");
  const { submitRequest } = await import("../src/requests/captureCore");
  const tr = await import("../src/requests/transitions");
  const { presignPutUrl } = await import("../src/storage/r2");
  const { buildStorageKey } = await import("../src/storage/storageKey");
  const { and, asc, desc, eq, inArray, isNull, sql } = await import("drizzle-orm");

  const nonce = randomUUID().slice(0, 8);
  const password = "bench-password-not-real";
  const META = { ip: "203.0.113.77", userAgent: "bench" };

  // ---- fixtures (owner connection, bypasses RLS on purpose) -------------
  const [dept] = await dbOwner.insert(s.department).values({ name: `Bench Dept ${nonce}`, code: `BNC-${nonce}`, ageingThresholdDays: 30 }).returning({ id: s.department.id });
  const [co] = await dbOwner.insert(s.company).values({ name: `Bench Co ${nonce}`, legalName: `Bench Co Pvt Ltd ${nonce}` }).returning({ id: s.company.id });
  const [head] = await dbOwner.insert(s.headOfAccount).values({ name: `Bench Head ${nonce}`, code: `BH-${nonce}` }).returning({ id: s.headOfAccount.id });
  const passwordHash = await hashSecret(password);
  const mk = async (label: string) => {
    const [u] = await dbOwner
      .insert(s.user)
      .values({ name: `Bench ${label} ${nonce}`, email: `bench-${label}-${nonce}@example.invalid`, passwordHash })
      .returning({ id: s.user.id, email: s.user.email });
    return u;
  };
  const requester = await mk("requester");
  const approver = await mk("approver");
  const accountant = await mk("accountant");
  const payer = await mk("payer");
  const grant = (userId: string, role: string) =>
    dbOwner.insert(s.roleGrant).values({
      userId,
      role: role as (typeof s.roleGrant.$inferInsert)["role"],
      deptScope: role === "accountant" || role === "payer" ? "global" : "list",
      departmentIds: role === "accountant" || role === "payer" ? undefined : [dept.id],
      companyScope: role === "accountant" || role === "payer" ? "list" : "n/a",
      companyIds: role === "accountant" || role === "payer" ? [co.id] : undefined,
      grantedBy: userId,
    });
  await grant(requester.id, "requester");
  await grant(approver.id, "approver");
  await grant(accountant.id, "accountant");
  await grant(payer.id, "payer");
  const [vendor] = await dbOwner.insert(s.vendor).values({ name: `Bench Vendor ${nonce}`, createdBy: accountant.id }).returning({ id: s.vendor.id });
  await dbOwner.insert(s.vendorBank).values({
    vendorId: vendor.id,
    beneficiaryName: `Bench Vendor ${nonce}`,
    accountNumberEncrypted: "unused",
    accountNumberLast4: "0000",
    ifsc: "TEST0000000",
    effectiveFrom: "2026-01-01",
    enteredBy: accountant.id,
    enteredAsRole: "accountant",
    verifiedBy: payer.id,
    verifiedAt: new Date(),
  });

  async function upload() {
    const fileId = randomUUID();
    const mime = "application/pdf";
    const storageKey = buildStorageKey("bills", fileId, mime);
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const res = await fetch(await presignPutUrl(storageKey, mime), { method: "PUT", headers: { "Content-Type": mime }, body: bytes });
    if (!res.ok) throw new Error(`fixture upload failed ${res.status}`);
    return { fileId, storageKey, mime, byteLength: bytes.length, sha256: randomUUID().padEnd(64, "0") };
  }

  // Warm the pool (TCP+TLS+auth is a one-time cost per connection, not
  // something a warm serverless instance pays per request).
  await Promise.all(
    [1, 2, 3, 4].map(() => rt.__unscopedRuntimeConnectionForGateTestOnly((tx) => tx.execute(sql`select pg_sleep(0.3)`))),
  ).catch(() => undefined);

  async function cleanup() {
  const userIds = [requester.id, approver.id, accountant.id, payer.id];
  const reqs = await dbOwner.select({ id: s.request.id }).from(s.request).where(eq(s.request.departmentId, dept.id));
  const reqIds = reqs.map((r) => r.id);
  if (reqIds.length) {
    for (const t of [s.payment, s.accounting, s.event, s.requestFile, s.duplicateCheck]) {
      await dbOwner.delete(t).where(inArray((t as unknown as { requestId: never }).requestId, reqIds));
    }
    await dbOwner.delete(s.request).where(inArray(s.request.id, reqIds));
  }
  await dbOwner.delete(s.session).where(inArray(s.session.userId, userIds));
  await dbOwner.delete(s.loginAttempt).where(inArray(s.loginAttempt.email, [requester.email]));
  await dbOwner.delete(s.roleGrant).where(inArray(s.roleGrant.userId, userIds));
  await dbOwner.delete(s.vendorBank).where(eq(s.vendorBank.vendorId, vendor.id));
  await dbOwner.delete(s.vendor).where(eq(s.vendor.id, vendor.id));
  await dbOwner.delete(s.headOfAccount).where(eq(s.headOfAccount.id, head.id));
  await dbOwner.delete(s.department).where(eq(s.department.id, dept.id));
  await dbOwner.delete(s.company).where(eq(s.company.id, co.id));
  await dbOwner.delete(s.user).where(inArray(s.user.id, userIds));
  }

  try {
    // ---- 1. login -------------------------------------------------------
    const login = await measure("login POST  attemptLogin (success, no MFA)", () =>
      attemptLogin({ email: requester.email, password, ...META }),
    );
    if (!login.ok) throw new Error("bench login failed: " + login.error);

    // ---- 2. what every authenticated render pays first --------------------
    const sess = await measure("every page: verifySession (session lookup)", () => store.findSessionByRawToken(login.rawToken, "active"));
    if (!sess) throw new Error("no session");

    // ---- 3. submit ------------------------------------------------------
    const file = await upload();
    const submitted = await measure("submitRequestAction  submitRequest (1 file)", () =>
      submitRequest({ userId: requester.id, ...META, departmentId: dept.id, amountMinor: 250000, invoiceNo: `INV-${nonce}`, attachments: [file] }),
    );
    if (!submitted.ok) throw new Error(submitted.error);
    const requestId = submitted.requestId;

    // ---- 4. /requests/[id] GET, before and after --------------------------
    // The "legacy" replica is the page exactly as it was: resolveViewerRole's
    // sequential role loop, then one scope for the ten reads, then separate
    // scopes for the role-specific extras. It runs on whichever runtime.ts is
    // checked out, so on the new runtime it isolates the runtime gain from the
    // page-restructuring gain.
    async function legacyRequestPage(userId: string, id: string) {
      const ROLE_PRIORITY = ["approver", "accountant", "payer", "requester", "super_admin", "developer"] as const;
      let resolved: { role: (typeof ROLE_PRIORITY)[number]; req: typeof s.request.$inferSelect } | null = null;
      for (const role of ROLE_PRIORITY) {
        try {
          const [row] = await rt.withGrantScope(userId, role, (tx) => tx.select().from(s.request).where(eq(s.request.id, id)));
          if (row) {
            resolved = { role, req: row };
            break;
          }
        } catch {
          continue;
        }
      }
      if (!resolved) return null;
      const { role, req } = resolved;
      await rt.withGrantScope(userId, role, async (tx) => {
        const [dept_] = await tx.select().from(s.department).where(eq(s.department.id, req.departmentId)).limit(1);
        const bills = await tx.select().from(s.requestFile).where(and(eq(s.requestFile.requestId, req.id), eq(s.requestFile.kind, "bill"))).orderBy(asc(s.requestFile.pageNo));
        const attachments = await tx.select().from(s.requestFile).where(and(eq(s.requestFile.requestId, req.id), eq(s.requestFile.kind, "comment_attachment"))).orderBy(asc(s.requestFile.createdAt));
        const acc = await tx.select().from(s.accounting).where(eq(s.accounting.requestId, req.id)).orderBy(desc(s.accounting.accountedAt));
        const [pay] = await tx.select().from(s.payment).where(eq(s.payment.requestId, req.id)).limit(1);
        const events = await tx.select({ event: s.event, actorName: s.user.name }).from(s.event).leftJoin(s.user, eq(s.user.id, s.event.actor)).where(eq(s.event.requestId, req.id)).orderBy(asc(s.event.at));
        const comments = await tx.select({ comment: s.comment, authorName: s.user.name }).from(s.comment).leftJoin(s.user, eq(s.user.id, s.comment.author)).where(eq(s.comment.requestId, req.id)).orderBy(asc(s.comment.at));
        const openQ = await tx.select({ query: s.query, n: s.user.name }).from(s.query).leftJoin(s.user, eq(s.user.id, s.query.raisedBy)).where(and(eq(s.query.requestId, req.id), isNull(s.query.resolvedAt))).orderBy(asc(s.query.at));
        const routed = req.routedApproverId ? await tx.select({ name: s.user.name }).from(s.user).where(eq(s.user.id, req.routedApproverId)).limit(1) : [];
        const { loadFlagContext } = await import("../src/flags/computeFlags");
        const flags = await loadFlagContext(tx, [req]);
        return [dept_, bills, attachments, acc, pay, events, comments, openQ, routed, flags];
      });
      if (role === "accountant") {
        await rt.withGrantScope(userId, "accountant", async (tx) => [
          await tx.select().from(s.company).where(eq(s.company.active, true)),
          await tx.select().from(s.headOfAccount).where(eq(s.headOfAccount.active, true)),
        ]);
        await rt.withActorScope(userId, (tx) =>
          tx.select({ id: s.roleGrant.id }).from(s.roleGrant).where(and(eq(s.roleGrant.userId, userId), eq(s.roleGrant.role, "super_admin"), isNull(s.roleGrant.revokedAt))).limit(1),
        );
      }
      if (role === "payer" && req.companyId) {
        await rt.withGrantScope(userId, "payer", (tx) => tx.select().from(s.company).where(eq(s.company.id, req.companyId!)).limit(1));
      }
      if (role === "payer" && req.stage === "to_pay") {
        const { checkPaymentBankReadiness } = await import("../src/vendors/verifyCore");
        await checkPaymentBankReadiness(userId, req.id);
      }
      return role;
    }

    let newPage: null | ((userId: string, id: string) => Promise<unknown>) = null;
    try {
      const mod = await import("../src/requests/requestView");
      newPage = mod.loadRequestView;
    } catch {
      /* pre-refactor tree: only the legacy replica exists */
    }

    async function pageBench(name: string, userId: string) {
      await measure(`GET /requests/[id] as ${name}  (legacy page logic)`, () => legacyRequestPage(userId, requestId));
      if (newPage) await measure(`GET /requests/[id] as ${name}  (current page logic)`, () => newPage!(userId, requestId));
    }

    await pageBench("requester (stage: awaiting_approval)", requester.id);
    await pageBench("approver  (stage: awaiting_approval)", approver.id);

    // ---- 5. desks ---------------------------------------------------------
    const ok = (r: { ok: boolean }, what: string) => {
      if (!r.ok) throw new Error(`${what} failed: ${JSON.stringify(r)}`);
    };
    ok(await measure("approveRequestAction  approveRequest", () => tr.approveRequest(approver.id, requestId, { cycle: "unspecified", dueDate: null, noteToAccountsAndPayer: null }, META)), "approve");
    await pageBench("accountant (stage: with_accounts)", accountant.id);
    ok(
      await measure("accountAction  accountRequest", () =>
        tr.accountRequest(accountant.id, requestId, { companyId: co.id, vendorId: vendor.id, headId: head.id, voucherNo: `V-${nonce}`, bookedOn: "2026-09-19" }, META),
      ),
      "account",
    );
    await pageBench("payer (stage: to_pay)", payer.id);
    ok(
      await measure("payAction  payRequest", () =>
        tr.payRequest(
          payer.id,
          requestId,
          { fromAccount: { id: "a", label: "Bench", bankName: "Bench Bank", accountNumber: "000", ifsc: "TEST0000000" }, mode: "neft", valueDate: "2026-09-19", amountMinor: 250000, tdsMinor: 0, reference: `UTR-${nonce}` },
          META,
        ),
      ),
      "pay",
    );

    // ---- summary ----------------------------------------------------------
    console.log("\n| path | statements | est. round trips | wall |\n|---|---:|---:|---:|");
    for (const r of rows) console.log(`| ${r.label} | ${r.statements} | ${r.flights} | ${(r.wallMs / 1000).toFixed(1)} s |`);


  } finally {
    await cleanup();
    await closeOwnerConnection();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
