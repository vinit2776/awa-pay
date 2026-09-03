import { eq, inArray, sql } from "drizzle-orm";
import { type Role, type ScopedTx, withGrantScope } from "@/db/runtime";
import { request, user } from "@/db/schema";
import { formatMinorUnits } from "@/lib/money";
import { sendEmail } from "./email";

// Called only from thin "use server" action wrappers, after their
// transition's transaction has already committed — never from a pure
// core. Each function opens its own short-lived, read-only transaction
// (as a role the acting user demonstrably holds, matching the one their
// transition just ran under) purely to resolve who to email and what
// their addresses are; the actual send happens outside that transaction,
// since AGENTS.md rule 4 is explicit that a slow or failing provider must
// never be able to roll back the action that triggered it.

type Recipient = { id: string; email: string };

type RequestContext = {
  ref: string;
  vendor: string | null;
  amountMinor: number;
  currency: string;
  departmentId: string;
  companyId: string | null;
  raisedBy: string;
};

async function loadContext(tx: ScopedTx, requestId: string): Promise<RequestContext | null> {
  const [row] = await tx
    .select({
      ref: request.ref,
      vendor: request.vendor,
      amountMinor: request.amountMinor,
      currency: request.currency,
      departmentId: request.departmentId,
      companyId: request.companyId,
      raisedBy: request.raisedBy,
    })
    .from(request)
    .where(eq(request.id, requestId));
  return row ?? null;
}

async function emailsForIds(tx: ScopedTx, ids: string[]): Promise<Recipient[]> {
  if (ids.length === 0) return [];
  return tx.select({ id: user.id, email: user.email }).from(user).where(inArray(user.id, ids));
}

// app_users_with_scope's own p_company_id IS NULL branch already skips the
// company check entirely, so it's correct — not just convenient — to
// always pass the request's current companyId (null before accounting,
// set after) rather than threading an extra "does this trigger care about
// company" flag through every call site.
async function recipientsWithRoles(
  tx: ScopedTx,
  actorId: string,
  targetRoles: Role[],
  departmentId: string,
  companyId: string | null,
): Promise<Recipient[]> {
  const rolesArray = sql.join(
    targetRoles.map((role) => sql`${role}`),
    sql`, `,
  );
  const scoped = await tx.execute<{ user_id: string }>(
    sql`select user_id from app_users_with_scope(ARRAY[${rolesArray}]::text[], ${departmentId}, ${companyId})`,
  );
  const ids = scoped.map((row) => row.user_id).filter((id) => id !== actorId);
  return emailsForIds(tx, ids);
}

// Every notifyX function below returns the list of email addresses it
// actually resolved and (attempted to) notify — not just void. This is
// what makes "the right people, and only the right people" testable
// against the real dev DB without needing a live send: tests can assert
// on this return value directly rather than needing to intercept Resend.
// Action wrappers calling these through next/server's after() simply
// don't use the return value.

async function notifyRoles(
  actorId: string,
  actorRole: Role,
  requestId: string,
  targetRoles: Role[],
  subject: string,
  bodyFor: (ctx: RequestContext) => string,
): Promise<string[]> {
  const result = await withGrantScope(actorId, actorRole, async (tx) => {
    const ctx = await loadContext(tx, requestId);
    if (!ctx) return null;
    const recipients = await recipientsWithRoles(tx, actorId, targetRoles, ctx.departmentId, ctx.companyId);
    return { ctx, recipients };
  });
  if (!result || result.recipients.length === 0) return [];
  await sendEmail({ to: result.recipients.map((r) => r.email), subject, text: bodyFor(result.ctx) });
  return result.recipients.map((r) => r.email);
}

// targetUserId is a function of ctx, not a fixed id, so the common case
// (notify whoever raised the request) doesn't need the caller to look up
// and thread `raisedBy` through separately — it's already loaded here.
async function notifyUser(
  actorId: string,
  actorRole: Role,
  requestId: string,
  targetUserId: (ctx: RequestContext) => string,
  subject: string,
  bodyFor: (ctx: RequestContext) => string,
): Promise<string[]> {
  const result = await withGrantScope(actorId, actorRole, async (tx) => {
    const ctx = await loadContext(tx, requestId);
    if (!ctx) return null;
    const target = targetUserId(ctx);
    if (target === actorId) return { ctx, recipients: [] }; // never notify someone about their own action
    const recipients = await emailsForIds(tx, [target]);
    return { ctx, recipients };
  });
  if (!result || result.recipients.length === 0) return [];
  await sendEmail({ to: result.recipients.map((r) => r.email), subject, text: bodyFor(result.ctx) });
  return result.recipients.map((r) => r.email);
}

async function notifyUsers(
  actorId: string,
  actorRole: Role,
  requestId: string,
  targetUserIds: string[],
  subject: string,
  bodyFor: (ctx: RequestContext) => string,
): Promise<string[]> {
  const ids = targetUserIds.filter((id) => id !== actorId);
  if (ids.length === 0) return [];
  const result = await withGrantScope(actorId, actorRole, async (tx) => {
    const ctx = await loadContext(tx, requestId);
    if (!ctx) return null;
    const recipients = await emailsForIds(tx, ids);
    return { ctx, recipients };
  });
  if (!result || result.recipients.length === 0) return [];
  await sendEmail({ to: result.recipients.map((r) => r.email), subject, text: bodyFor(result.ctx) });
  return result.recipients.map((r) => r.email);
}

function subjectLine(ctx: RequestContext): string {
  return `${ctx.ref}${ctx.vendor ? ` — ${ctx.vendor}` : ""}`;
}

// --- Per-trigger recipients, matching docs/START-HERE-slice-2.md's table ---

export function notifyApprove(actorId: string, requestId: string): Promise<string[]> {
  return notifyRoles(
    actorId,
    "approver",
    requestId,
    ["accountant"],
    "Approved · awaiting accounting",
    (ctx) => `${subjectLine(ctx)} was approved and is waiting to be accounted. Amount: ${formatMinorUnits(ctx.amountMinor, ctx.currency)}.`,
  );
}

export function notifyReturnToRequester(actorId: string, requestId: string, reason: string): Promise<string[]> {
  return notifyUser(
    actorId,
    "approver",
    requestId,
    (ctx) => ctx.raisedBy,
    "Returned for correction",
    (ctx) => `${subjectLine(ctx)} was returned to you for correction.\n\nReason: ${reason}`,
  );
}

export function notifyHold(actorId: string, requestId: string, reason: string): Promise<string[]> {
  return notifyUser(
    actorId,
    "approver",
    requestId,
    (ctx) => ctx.raisedBy,
    "Placed on hold",
    (ctx) => `${subjectLine(ctx)} was placed on hold.\n\nReason: ${reason}`,
  );
}

export function notifyReject(actorId: string, requestId: string, reason: string): Promise<string[]> {
  return notifyUser(actorId, "approver", requestId, (ctx) => ctx.raisedBy, "Rejected", (ctx) => `${subjectLine(ctx)} was rejected.\n\nReason: ${reason}`);
}

export function notifyAccount(actorId: string, requestId: string): Promise<string[]> {
  return notifyRoles(actorId, "accountant", requestId, ["payer"], "Ready to pay", (ctx) => `${subjectLine(ctx)} has been accounted and is ready for payment.`);
}

export function notifyReturnToApprover(actorId: string, requestId: string, reason: string): Promise<string[]> {
  return notifyRoles(
    actorId,
    "accountant",
    requestId,
    ["approver"],
    "Returned to approver",
    (ctx) => `${subjectLine(ctx)} was sent back to approval.\n\nReason: ${reason}`,
  );
}

export function notifyPay(actorId: string, requestId: string): Promise<string[]> {
  return notifyUser(actorId, "payer", requestId, (ctx) => ctx.raisedBy, "Paid", (ctx) => `${subjectLine(ctx)} has been paid.`);
}

export function notifyReturnToAccounts(actorId: string, requestId: string, reason: string): Promise<string[]> {
  return notifyRoles(
    actorId,
    "payer",
    requestId,
    ["accountant"],
    "Returned to accounts",
    (ctx) => `${subjectLine(ctx)} was sent back to accounts.\n\nReason: ${reason}`,
  );
}

export function notifyResubmit(actorId: string, requestId: string): Promise<string[]> {
  return notifyRoles(actorId, "requester", requestId, ["approver"], "Resubmitted", (ctx) => `${subjectLine(ctx)} was resubmitted and needs re-approval.`);
}

export function notifyQueryRaised(actorId: string, actorRole: Role, requestId: string, directedAt: Role[], question: string): Promise<string[]> {
  return notifyRoles(actorId, actorRole, requestId, directedAt, "A question needs an answer", (ctx) => `${subjectLine(ctx)} has an open question:\n\n${question}`);
}

export function notifyQueryAnswered(actorId: string, actorRole: Role, requestId: string, raisedBy: string, answer: string): Promise<string[]> {
  // raisedBy here is who raised the *query*, not necessarily the request's
  // own raisedBy — any conversation-capable role can raise a query.
  return notifyUser(actorId, actorRole, requestId, () => raisedBy, "Your question was answered", (ctx) => `${subjectLine(ctx)}:\n\n${answer}`);
}

export function notifyNudge(actorId: string, actorRole: Role, requestId: string, toRole: Role): Promise<string[]> {
  return notifyRoles(actorId, actorRole, requestId, [toRole], "Nudge: any update?", (ctx) => `${subjectLine(ctx)} — any update?`);
}

export function notifyMentions(actorId: string, actorRole: Role, requestId: string, mentionedUserIds: string[], body: string): Promise<string[]> {
  return notifyUsers(actorId, actorRole, requestId, mentionedUserIds, "You were mentioned", (ctx) => `${subjectLine(ctx)}:\n\n${body}`);
}
