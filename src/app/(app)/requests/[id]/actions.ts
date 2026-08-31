"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { verifySession } from "@/auth/dal";
import { postComment, type CommentAttachment, type PostCommentResult } from "@/conversation/commentsCore";
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

async function afterTransition(requestId: string, result: TransitionResult): Promise<TransitionResult> {
  if (result.ok) {
    revalidatePath(`/requests/${requestId}`);
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
  }
  return result;
}

export async function approveAction(
  requestId: string,
  input: { cycle: PaymentCycle; dueDate: string | null; noteToAccountsAndPayer: string | null },
): Promise<TransitionResult> {
  const session = await verifySession();
  const meta = await getClientMeta();
  return afterTransition(requestId, await approveRequest(session.userId, requestId, input, meta));
}

export async function returnToRequesterAction(requestId: string, input: { reason: string }): Promise<TransitionResult> {
  const session = await verifySession();
  const meta = await getClientMeta();
  return afterTransition(requestId, await returnRequestToRequester(session.userId, requestId, input, meta));
}

export async function holdAction(
  requestId: string,
  input: { reviewOn: string; subReason: HoldSubReason; reason: string },
): Promise<TransitionResult> {
  const session = await verifySession();
  const meta = await getClientMeta();
  return afterTransition(requestId, await holdRequest(session.userId, requestId, input, meta));
}

export async function rejectAction(requestId: string, input: { reason: string }): Promise<TransitionResult> {
  const session = await verifySession();
  const meta = await getClientMeta();
  return afterTransition(requestId, await rejectRequest(session.userId, requestId, input, meta));
}

export async function releaseHoldAction(requestId: string): Promise<TransitionResult> {
  const session = await verifySession();
  const meta = await getClientMeta();
  return afterTransition(requestId, await releaseHold(session.userId, requestId, meta));
}

export async function accountAction(
  requestId: string,
  input: { companyId: string; headId: string; voucherNo: string; bookedOn: string },
): Promise<TransitionResult> {
  const session = await verifySession();
  const meta = await getClientMeta();
  return afterTransition(requestId, await accountRequest(session.userId, requestId, input, meta));
}

export async function returnToApproverAction(requestId: string, input: { reason: string }): Promise<TransitionResult> {
  const session = await verifySession();
  const meta = await getClientMeta();
  return afterTransition(requestId, await returnToApprover(session.userId, requestId, input, meta));
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
  return afterTransition(requestId, await payRequest(session.userId, requestId, input, meta));
}

export async function returnToAccountsAction(requestId: string, input: { reason: string }): Promise<TransitionResult> {
  const session = await verifySession();
  const meta = await getClientMeta();
  return afterTransition(requestId, await returnToAccounts(session.userId, requestId, input, meta));
}
