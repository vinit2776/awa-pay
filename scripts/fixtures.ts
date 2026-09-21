// Find and remove test fixtures — shared by tests/*.test.ts's afterAll
// (one nonce at a time) and scripts/cleanup-fixtures.ts (every nonce, on
// demand).
//
// Why this exists instead of each test file's own hand-written delete
// list: those lists rot. Every new table a fixture can touch
// (duplicate_check, extraction_attempt, vendor_document, ...) needs adding
// to every file, and the first FK violation aborts the whole afterAll —
// and role_grant's delete sat *after* the request deletes, so a failure
// left ACTIVE grants behind on users that then looked like real accountants
// to src/notifications/recipients.ts. Here the order lives in one place, the
// grants are revoked first in their own committed statement, and the run
// throws (never returns quietly) if anything survives.
//
// What counts as a fixture is purely the naming convention every test
// already follows, nothing else:
//   users        email  ...-<nonce>@example.invalid
//   departments  name or code has a standalone <nonce> token
//   companies    name has a standalone <nonce> token
//   heads        name or code has a standalone <nonce> token
//   vendors      name has a standalone <nonce> token
// where <nonce> is 8 lowercase hex characters (randomUUID().slice(0, 8)).
// Anything not matching — the walkthrough users (*@awa-pay.test) and their
// departments, companies, heads, vendors and requests — is never selected.
import { and, arrayOverlaps, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import {
  accounting,
  comment,
  company,
  department,
  duplicateCheck,
  event,
  extraction,
  extractionAttempt,
  headOfAccount,
  loginAttempt,
  mfaBackupCode,
  nudge,
  payment,
  query,
  request,
  requestFile,
  roleGrant,
  session,
  user,
  vendor,
  vendorBank,
  vendorDocument,
} from "../src/db/schema";
import type { OwnerDb } from "./db-owner";

/** Belt and braces on top of the email regex: these are never fixtures. */
const PROTECTED_EMAIL_SUFFIX = "@awa-pay.test";

const NONCE_RE = /^[0-9a-f]{8}$/;
const ANY_NONCE = "[0-9a-f]{8}";

export type FixtureSet = {
  users: { id: string; email: string; createdAt: Date; activeGrants: number }[];
  departments: { id: string; name: string; code: string }[];
  companies: { id: string; name: string }[];
  heads: { id: string; name: string; code: string }[];
  vendors: { id: string; name: string }[];
  /** Requests in a fixture department — deleted along with it. */
  requests: { id: string; ref: string; stage: string }[];
  /**
   * Requests that reference a fixture user/company/vendor/head but do NOT
   * sit in a fixture department. Never deleted; their presence aborts the
   * purge, because something real is entangled with test data.
   */
  foreignRequests: { id: string; ref: string; stage: string; departmentId: string }[];
  /** Grants held by non-fixture users whose scope arrays name a fixture department/company. Reported only. */
  danglingGrantCount: number;
};

export type FindOptions = {
  /** Match exactly this nonce (a test file's own). Omit to match every nonce. */
  nonce?: string;
  /**
   * Only fixture families (one test run = one nonce) whose NEWEST root was
   * created before this instant — keeps a sweep off a run still in flight.
   * Per family, never per row: a run's newest vendor can be minutes old
   * while its users are an hour old, and deleting one without the other is
   * exactly what the foreign keys would (rightly) refuse.
   */
  olderThan?: Date;
};

const NONCE_TOKEN_RE = /(?:^|[ -])([0-9a-f]{8})(?:$|[ @-])/;

/** The 8-hex nonce embedded in a fixture's name, code or email. */
function nonceOf(text: string): string {
  const m = NONCE_TOKEN_RE.exec(text);
  if (!m) throw new Error(`No fixture nonce found in ${JSON.stringify(text)} although it matched the fixture pattern.`);
  return m[1];
}

function nonceFamiliesNewerThan(cutoff: Date, roots: { text: string; createdAt: Date }[]): Set<string> {
  const newest = new Map<string, number>();
  for (const r of roots) {
    const n = nonceOf(r.text);
    newest.set(n, Math.max(newest.get(n) ?? 0, r.createdAt.getTime()));
  }
  return new Set([...newest].filter(([, t]) => t >= cutoff.getTime()).map(([n]) => n));
}

export async function findFixtures(db: OwnerDb, opts: FindOptions = {}): Promise<FixtureSet> {
  if (opts.nonce !== undefined && !NONCE_RE.test(opts.nonce)) {
    throw new Error(`Refusing to search for malformed fixture nonce ${JSON.stringify(opts.nonce)} (want 8 lowercase hex chars).`);
  }
  const tok = opts.nonce ?? ANY_NONCE;
  const tokenRe = `(^|[ -])${tok}($|[ -])`;
  const emailRe = `-${tok}@example\\.invalid$`;

  const allUsers = await db
    .select({ id: user.id, email: user.email, createdAt: user.createdAt })
    .from(user)
    .where(sql`${user.email} ~ ${emailRe}`);
  const protectedHit = allUsers.find((u) => u.email.toLowerCase().endsWith(PROTECTED_EMAIL_SUFFIX));
  if (protectedHit) {
    throw new Error(`Fixture matcher selected a protected walkthrough user (${protectedHit.email}) — refusing to continue.`);
  }

  const allDepartments = await db
    .select({ id: department.id, name: department.name, code: department.code, createdAt: department.createdAt })
    .from(department)
    .where(or(sql`${department.name} ~ ${tokenRe}`, sql`${department.code} ~ ${tokenRe}`));
  const allCompanies = await db
    .select({ id: company.id, name: company.name, createdAt: company.createdAt })
    .from(company)
    .where(sql`${company.name} ~ ${tokenRe}`);
  const allHeads = await db
    .select({ id: headOfAccount.id, name: headOfAccount.name, code: headOfAccount.code, createdAt: headOfAccount.createdAt })
    .from(headOfAccount)
    .where(or(sql`${headOfAccount.name} ~ ${tokenRe}`, sql`${headOfAccount.code} ~ ${tokenRe}`));
  const allVendors = await db
    .select({ id: vendor.id, name: vendor.name, createdAt: vendor.createdAt })
    .from(vendor)
    .where(sql`${vendor.name} ~ ${tokenRe}`);

  const inFlight = opts.olderThan ? nonceFamiliesNewerThan(opts.olderThan, [
    ...allUsers.map((u) => ({ text: u.email, createdAt: u.createdAt })),
    ...allDepartments.map((d) => ({ text: `${d.name} ${d.code}`, createdAt: d.createdAt })),
    ...allCompanies.map((c) => ({ text: c.name, createdAt: c.createdAt })),
    ...allHeads.map((h) => ({ text: `${h.name} ${h.code}`, createdAt: h.createdAt })),
    ...allVendors.map((v) => ({ text: v.name, createdAt: v.createdAt })),
  ]) : new Set<string>();
  const settled = (text: string) => !inFlight.has(nonceOf(text));

  const users = allUsers.filter((u) => settled(u.email));
  const userIds = users.map((u) => u.id);

  const grantCounts = userIds.length
    ? await db
        .select({ userId: roleGrant.userId, n: sql<number>`count(*)::int` })
        .from(roleGrant)
        .where(and(inArray(roleGrant.userId, userIds), isNull(roleGrant.revokedAt)))
        .groupBy(roleGrant.userId)
    : [];
  const activeByUser = new Map(grantCounts.map((g) => [g.userId, g.n]));

  const departments = allDepartments.filter((d) => settled(`${d.name} ${d.code}`)).map(({ id, name, code }) => ({ id, name, code }));
  const companies = allCompanies.filter((c) => settled(c.name)).map(({ id, name }) => ({ id, name }));
  const heads = allHeads.filter((h) => settled(`${h.name} ${h.code}`)).map(({ id, name, code }) => ({ id, name, code }));
  const vendors = allVendors.filter((v) => settled(v.name)).map(({ id, name }) => ({ id, name }));

  const deptIds = departments.map((d) => d.id);
  const companyIds = companies.map((c) => c.id);
  const headIds = heads.map((h) => h.id);
  const vendorIds = vendors.map((v) => v.id);

  // Every request touching a fixture root, whichever way it touches it.
  const touches: SQL[] = [];
  if (deptIds.length) touches.push(inArray(request.departmentId, deptIds));
  if (userIds.length) touches.push(inArray(request.raisedBy, userIds), inArray(request.routedApproverId, userIds));
  const accountingTouch: SQL[] = [];
  if (companyIds.length) accountingTouch.push(inArray(accounting.companyId, companyIds));
  if (vendorIds.length) accountingTouch.push(inArray(accounting.vendorId, vendorIds));
  if (headIds.length) accountingTouch.push(inArray(accounting.headId, headIds));
  if (accountingTouch.length) {
    touches.push(sql`exists (select 1 from ${accounting} where ${accounting.requestId} = ${request.id} and (${or(...accountingTouch)}))`);
  }
  const touched = touches.length
    ? await db
        .select({ id: request.id, ref: request.ref, stage: request.stage, departmentId: request.departmentId })
        .from(request)
        .where(or(...touches))
    : [];
  const fixtureDept = new Set(deptIds);
  const requests = touched.filter((r) => fixtureDept.has(r.departmentId));
  const foreignRequests = touched.filter((r) => !fixtureDept.has(r.departmentId));

  const overlaps: SQL[] = [];
  if (deptIds.length) overlaps.push(arrayOverlaps(roleGrant.departmentIds, deptIds));
  if (companyIds.length) overlaps.push(arrayOverlaps(roleGrant.companyIds, companyIds));
  const danglingGrantCount = overlaps.length
    ? (
        await db
          .select({ n: sql<number>`count(*)::int` })
          .from(roleGrant)
          .where(and(or(...overlaps), userIds.length ? notInArray(roleGrant.userId, userIds) : undefined))
      )[0].n
    : 0;

  return {
    users: users.map((u) => ({ ...u, activeGrants: activeByUser.get(u.id) ?? 0 })),
    departments,
    companies,
    heads,
    vendors,
    requests: requests.map(({ id, ref, stage }) => ({ id, ref, stage })),
    foreignRequests,
    danglingGrantCount,
  };
}

export function isEmpty(set: FixtureSet): boolean {
  return (
    set.users.length + set.departments.length + set.companies.length + set.heads.length + set.vendors.length + set.requests.length === 0
  );
}

/**
 * Revokes every active grant held by the fixture users and deletes their
 * sessions, in a plain committed statement of its own. This is the part
 * that matters for live impact — an active accountant grant is what makes
 * a fixture user a notification recipient — so it is deliberately not part
 * of the big delete transaction that can roll back.
 */
export async function revokeFixtureAccess(db: OwnerDb, set: FixtureSet): Promise<{ grantsRevoked: number; sessionsDeleted: number }> {
  const ids = set.users.map((u) => u.id);
  if (ids.length === 0) return { grantsRevoked: 0, sessionsDeleted: 0 };
  const revoked = await db
    .update(roleGrant)
    .set({ revokedAt: new Date() })
    .where(and(inArray(roleGrant.userId, ids), isNull(roleGrant.revokedAt)))
    .returning({ id: roleGrant.id });
  const sessions = await db.delete(session).where(inArray(session.userId, ids)).returning({ id: session.id });
  return { grantsRevoked: revoked.length, sessionsDeleted: sessions.length };
}

export class ForeignReferenceError extends Error {
  constructor(public readonly foreign: FixtureSet["foreignRequests"]) {
    super(
      `${foreign.length} request(s) outside any fixture department reference fixture users/companies/vendors/heads ` +
        `(${foreign.map((r) => r.ref).join(", ")}). Not deleting anything — resolve by hand.`,
    );
    this.name = "ForeignReferenceError";
  }
}

class DryRunRollback extends Error {
  constructor(public readonly counts: Record<string, number>) {
    super("dry run");
  }
}

/**
 * Deletes the set in one transaction, children before parents, so it is
 * all-or-nothing: a foreign key from something that is NOT a fixture
 * (a walkthrough row pointing at a test user, say) aborts the whole thing
 * with Postgres's own error and changes nothing. `dryRun` executes the
 * identical statements and rolls back, so the returned per-table counts
 * are what a real run would delete, and FK problems surface before commit.
 */
export async function purgeFixtures(db: OwnerDb, set: FixtureSet, opts: { dryRun?: boolean } = {}): Promise<Record<string, number>> {
  if (set.foreignRequests.length > 0) throw new ForeignReferenceError(set.foreignRequests);

  const userIds = set.users.map((u) => u.id);
  const userEmails = set.users.map((u) => u.email);
  const reqIds = set.requests.map((r) => r.id);
  const deptIds = set.departments.map((d) => d.id);
  const companyIds = set.companies.map((c) => c.id);
  const headIds = set.heads.map((h) => h.id);
  const vendorIds = set.vendors.map((v) => v.id);

  try {
    return await db.transaction(async (tx) => {
      const counts: Record<string, number> = {};
      const del = async (label: string, run: () => Promise<{ length: number }>) => {
        counts[label] = (await run()).length;
      };

      if (reqIds.length) {
        await del("duplicate_check", () => tx.delete(duplicateCheck).where(inArray(duplicateCheck.requestId, reqIds)).returning({ id: duplicateCheck.id }));
      }
      // Attempts made before a request existed (request_id null) belong to the user; the rest to their request.
      const attemptFilters: SQL[] = [];
      if (reqIds.length) attemptFilters.push(inArray(extractionAttempt.requestId, reqIds));
      if (userIds.length) attemptFilters.push(and(inArray(extractionAttempt.attemptedBy, userIds), isNull(extractionAttempt.requestId))!);
      if (attemptFilters.length) {
        const attempts = await tx.select({ id: extractionAttempt.id }).from(extractionAttempt).where(or(...attemptFilters));
        const attemptIds = attempts.map((a) => a.id);
        if (attemptIds.length) {
          await del("extraction", () => tx.delete(extraction).where(inArray(extraction.attemptId, attemptIds)).returning({ id: extraction.id }));
          await del("extraction_attempt", () => tx.delete(extractionAttempt).where(inArray(extractionAttempt.id, attemptIds)).returning({ id: extractionAttempt.id }));
        }
      }
      if (reqIds.length) {
        await del("nudge", () => tx.delete(nudge).where(inArray(nudge.requestId, reqIds)).returning({ id: nudge.id }));
        await del("payment", () => tx.delete(payment).where(inArray(payment.requestId, reqIds)).returning({ id: payment.id }));
        await del("query", () => tx.delete(query).where(inArray(query.requestId, reqIds)).returning({ id: query.id }));
        // request_file references comment as well as request — files first, then comments.
        const comments = await tx.select({ id: comment.id }).from(comment).where(inArray(comment.requestId, reqIds));
        const commentIds = comments.map((c) => c.id);
        await del("request_file", () =>
          tx
            .delete(requestFile)
            .where(or(inArray(requestFile.requestId, reqIds), commentIds.length ? inArray(requestFile.commentId, commentIds) : undefined))
            .returning({ id: requestFile.id }),
        );
        await del("comment", () => tx.delete(comment).where(inArray(comment.requestId, reqIds)).returning({ id: comment.id }));
        await del("accounting", () => tx.delete(accounting).where(inArray(accounting.requestId, reqIds)).returning({ id: accounting.id }));
      }
      // Events of fixture requests, plus request-less events (auth) whose actor is a fixture user.
      const eventFilters: SQL[] = [];
      if (reqIds.length) eventFilters.push(inArray(event.requestId, reqIds));
      if (userIds.length) eventFilters.push(and(inArray(event.actor, userIds), isNull(event.requestId))!);
      if (eventFilters.length) {
        await del("event", () => tx.delete(event).where(or(...eventFilters)).returning({ id: event.id }));
      }
      if (reqIds.length) {
        await del("request", () => tx.delete(request).where(inArray(request.id, reqIds)).returning({ id: request.id }));
      }
      if (vendorIds.length) {
        await del("vendor_document", () => tx.delete(vendorDocument).where(inArray(vendorDocument.vendorId, vendorIds)).returning({ id: vendorDocument.id }));
        await del("vendor_bank", () => tx.delete(vendorBank).where(inArray(vendorBank.vendorId, vendorIds)).returning({ id: vendorBank.id }));
        await del("vendor", () => tx.delete(vendor).where(inArray(vendor.id, vendorIds)).returning({ id: vendor.id }));
      }
      if (companyIds.length) await del("company", () => tx.delete(company).where(inArray(company.id, companyIds)).returning({ id: company.id }));
      if (headIds.length) await del("head_of_account", () => tx.delete(headOfAccount).where(inArray(headOfAccount.id, headIds)).returning({ id: headOfAccount.id }));
      if (deptIds.length) await del("department", () => tx.delete(department).where(inArray(department.id, deptIds)).returning({ id: department.id }));
      if (userIds.length) {
        await del("session", () => tx.delete(session).where(inArray(session.userId, userIds)).returning({ id: session.id }));
        await del("mfa_backup_code", () => tx.delete(mfaBackupCode).where(inArray(mfaBackupCode.userId, userIds)).returning({ id: mfaBackupCode.id }));
        await del("login_attempt", () => tx.delete(loginAttempt).where(inArray(loginAttempt.email, userEmails)).returning({ id: loginAttempt.id }));
        await del("role_grant", () => tx.delete(roleGrant).where(inArray(roleGrant.userId, userIds)).returning({ id: roleGrant.id }));
        await del("user", () => tx.delete(user).where(inArray(user.id, userIds)).returning({ id: user.id }));
      }

      if (opts.dryRun) throw new DryRunRollback(counts);
      return counts;
    });
  } catch (err) {
    if (err instanceof DryRunRollback) return err.counts;
    throw err;
  }
}

/** Human-readable list of anything from the set still in the database. */
async function remaining(db: OwnerDb, set: FixtureSet): Promise<string[]> {
  const probes: [string, string[], (ids: string[]) => Promise<unknown[]>][] = [
    ["user(s)", set.users.map((u) => u.id), (ids) => db.select({ id: user.id }).from(user).where(inArray(user.id, ids))],
    ["department(s)", set.departments.map((d) => d.id), (ids) => db.select({ id: department.id }).from(department).where(inArray(department.id, ids))],
    ["company(ies)", set.companies.map((c) => c.id), (ids) => db.select({ id: company.id }).from(company).where(inArray(company.id, ids))],
    ["head(s)", set.heads.map((h) => h.id), (ids) => db.select({ id: headOfAccount.id }).from(headOfAccount).where(inArray(headOfAccount.id, ids))],
    ["vendor(s)", set.vendors.map((v) => v.id), (ids) => db.select({ id: vendor.id }).from(vendor).where(inArray(vendor.id, ids))],
    ["request(s)", set.requests.map((r) => r.id), (ids) => db.select({ id: request.id }).from(request).where(inArray(request.id, ids))],
  ];
  const left: string[] = [];
  for (const [label, ids, probe] of probes) {
    if (ids.length === 0) continue;
    const rows = await probe(ids);
    if (rows.length > 0) left.push(`${rows.length} ${label}`);
  }
  return left;
}

/**
 * The afterAll entry point: everything a test file created, found by its
 * nonce alone (so it works even if beforeAll died half way and no ids were
 * ever assigned), removed, and verified gone. Throws — never resolves
 * quietly — if anything is left, naming exactly what and how to clear it.
 * Callers still close the owner connection themselves, in a finally.
 */
export async function cleanupFixturesForNonce(db: OwnerDb, nonce: string): Promise<void> {
  const set = await findFixtures(db, { nonce });
  if (isEmpty(set)) return;

  // First, and committed on its own: dead grants can't receive notifications
  // or open sessions even if everything after this fails.
  await revokeFixtureAccess(db, set);

  try {
    await purgeFixtures(db, set);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `FIXTURE CLEANUP FAILED for nonce ${nonce}: ${reason}\n` +
        `Grants for its ${set.users.length} user(s) were revoked, but the rows are still in the test database. ` +
        `Clear them with: npm run db:cleanup-fixtures -- --target test --min-age-minutes 0 --apply`,
      { cause: err },
    );
  }

  const left = await remaining(db, set);
  if (left.length > 0) {
    throw new Error(`FIXTURE CLEANUP INCOMPLETE for nonce ${nonce}: still present after purge: ${left.join(", ")}.`);
  }
}
