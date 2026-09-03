"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import type { Role } from "@/db/runtime";
import { verifySession } from "@/auth/dal";
import { postComment, type CommentAttachment, type PostCommentResult } from "@/conversation/commentsCore";
import { sendNudge, type NudgeResult } from "@/conversation/nudgesCore";
import { answerQuery, raiseQuery, type AnswerResult, type QueryResult } from "@/conversation/queriesCore";
import {
  notifyAccount,
  notifyApprove,
  notifyHold,
  notifyMentions,
  notifyNudge,
  notifyPay,
  notifyQueryAnswered,
  notifyQueryRaised,
  notifyReject,
  notifyReturnToAccounts,
  notifyReturnToApprover,
  notifyReturnToRequester,
} from "@/notifications/recipients";
import {
  accountRequest,
  approveRequest,
  holdRequest,
  payRequest,
  rejectRequest,
  releaseHold,
  returnRequestToRequester,
  returnToAccounts,
  returnToApprover,
  withdrawRequest,
  type AdviceAttachment,
  type FromAccount,
  type HoldSubReason,
  type PaymentCycle,
  type PaymentMode,
  type TransitionResult,
} from "@/requests/transitions";
import { mintUploadSlot, type UploadSlotResult } from "@/storage/uploadSlot";

async function getClientMeta(): Promise<{ ip: string; userAgent: string | undefined }> {
  const h = await headers();
  const forwardedFor = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwardedFor || h.get("x-real-ip") || "unknown";
  return { ip, userAgent: h.get("user-agent") ?? undefined };
}

async function afterTransition(requestId: string, result: TransitionResult, notify?: () => Promise<unknown>): Promise<TransitionResult> {
  if (result.ok) {
    revalidatePath(`/requests/${requestId}`);
    // Scheduled via next/server's after(), not just fired-and-forgotten:
    // a bare `void promise` risks the serverless function being torn down
    // before the send completes once this action's response has gone out.
    // after() keeps the invocation alive until the callback settles (via
    // Vercel's waitUntil under the hood) without making the caller wait
    // for it — the transition this notification describes has already
    // committed, so per AGENTS.md rule 4 a slow or failing provider must
    // never be able to delay or roll back the response either. notify()
    // itself never throws (src/notifications/email.ts swallows every
    // failure mode into a console.error).
    if (notify) after(notify);
  }
  return result;
}

export async function requestAdviceUploadSlot(mime: string): Promise<UploadSlotResult> {
  await verifySession();
  return mintUploadSlot(mime);
}

export async function requestCommentAttachmentUploadSlot(mime: string): Promise<UploadSlotResult> {
  await verifySession();
  return mintUploadSlot(mime);
}

export async function postCommentAction(
  requestId: string,
  input: { body: string; attachments: CommentAttachment[] },
): Promise<PostCommentResult> {
  const session = await verifySession();
  const result = await postComment({ userId: session.userId, requestId, body: input.body, attachments: input.attachments });
  if (result.ok) {
    revalidatePath(`/requests/${requestId}`);
    if (result.mentions.length > 0) {
      after(() => notifyMentions(session.userId, result.role, requestId, result.mentions, input.body));
    }
  }
  return result;
}

export async function approveAction(
  requestId: string,
  input: { cycle: PaymentCycle; dueDate: string | null; noteToAccountsAndPayer: string | null },
): Promise<TransitionResult> {
  const session = await verifySession();
  const meta = await getClientMeta();
  return afterTransition(requestId, await approveRequest(session.userId, requestId, input, meta), () => notifyApprove(session.userId, requestId));
}

export async function returnToRequesterAction(requestId: string, input: { reason: string }): Promise<TransitionResult> {
  const session = await verifySession();
  const meta = await getClientMeta();
  return afterTransition(requestId, await returnRequestToRequester(session.userId, requestId, input, meta), () =>
    notifyReturnToRequester(session.userId, requestId, input.reason),
  );
}

export async function holdAction(
  requestId: string,
  input: { reviewOn: string; subReason: HoldSubReason; reason: string },
): Promise<TransitionResult> {
  const session = await verifySession();
  const meta = await getClientMeta();
  return afterTransition(requestId, await holdRequest(session.userId, requestId, input, meta), () => notifyHold(session.userId, requestId, input.reason));
}

export async function rejectAction(requestId: string, input: { reason: string }): Promise<TransitionResult> {
  const session = await verifySession();
  const meta = await getClientMeta();
  return afterTransition(requestId, await rejectRequest(session.userId, requestId, input, meta), () =>
    notifyReject(session.userId, requestId, input.reason),
  );
}

export async function releaseHoldAction(requestId: string): Promise<TransitionResult> {
  const session = await verifySession();
  const meta = await getClientMeta();
  // No notification: ownership doesn't change (the approver owned it
  // before and after), see docs/START-HERE-slice-2.md's recipient table.
  return afterTransition(requestId, await releaseHold(session.userId, requestId, meta));
}

export async function accountAction(
  requestId: string,
  input: { companyId: string; headId: string; voucherNo: string; bookedOn: string },
): Promise<TransitionResult> {
  const session = await verifySession();
  const meta = await getClientMeta();
  return afterTransition(requestId, await accountRequest(session.userId, requestId, input, meta), () => notifyAccount(session.userId, requestId));
}

export async function returnToApproverAction(requestId: string, input: { reason: string }): Promise<TransitionResult> {
  const session = await verifySession();
  const meta = await getClientMeta();
  return afterTransition(requestId, await returnToApprover(session.userId, requestId, input, meta), () =>
    notifyReturnToApprover(session.userId, requestId, input.reason),
  );
}

export async function payAction(
  requestId: string,
  input: {
    fromAccount: FromAccount;
    mode: PaymentMode;
    valueDate: string;
    amountMinor: number;
    tdsMinor: number;
    reference: string;
    advice?: AdviceAttachment;
  },
): Promise<TransitionResult> {
  const session = await verifySession();
  const meta = await getClientMeta();
  return afterTransition(requestId, await payRequest(session.userId, requestId, input, meta), () => notifyPay(session.userId, requestId));
}

export async function returnToAccountsAction(requestId: string, input: { reason: string }): Promise<TransitionResult> {
  const session = await verifySession();
  const meta = await getClientMeta();
  return afterTransition(requestId, await returnToAccounts(session.userId, requestId, input, meta), () =>
    notifyReturnToAccounts(session.userId, requestId, input.reason),
  );
}

export async function withdrawAction(requestId: string): Promise<TransitionResult> {
  const session = await verifySession();
  const meta = await getClientMeta();
  // No notification: nothing was in anyone's queue at 'raised' besides
  // the requester themselves, who is the actor.
  return afterTransition(requestId, await withdrawRequest(session.userId, requestId, meta));
}

export async function raiseQueryAction(requestId: string, input: { directedAt: Role[]; question: string }): Promise<QueryResult> {
  const session = await verifySession();
  const meta = await getClientMeta();
  const result = await raiseQuery(session.userId, requestId, input, meta);
  if (result.ok) {
    revalidatePath(`/requests/${requestId}`);
    after(() => notifyQueryRaised(session.userId, result.role, requestId, input.directedAt, input.question));
  }
  return result;
}

export async function answerQueryAction(requestId: string, queryId: string, input: { answer: string }): Promise<AnswerResult> {
  const session = await verifySession();
  const meta = await getClientMeta();
  const result = await answerQuery(session.userId, requestId, queryId, input, meta);
  if (result.ok) {
    revalidatePath(`/requests/${requestId}`);
    after(() => notifyQueryAnswered(session.userId, result.role, requestId, result.raisedBy, input.answer));
  }
  return result;
}

export async function sendNudgeAction(requestId: string): Promise<NudgeResult> {
  const session = await verifySession();
  const meta = await getClientMeta();
  const result = await sendNudge(session.userId, requestId, meta);
  if (result.ok) {
    revalidatePath(`/requests/${requestId}`);
    after(() => notifyNudge(session.userId, result.role, requestId, result.toRole));
  }
  return result;
}
