import { inArray, sql } from "drizzle-orm";
import { withGrantScope } from "@/db/runtime";
import { comment, requestFile, user } from "@/db/schema";
import { resolveViewerRole } from "@/requests/viewerRole";
import { resolveMentions } from "./mentions";
import { CONVERSATION_ROLES } from "./roles";

// Pure orchestration, no next/headers — mirrors resubmitCore.ts's shape.

export type CommentAttachment = { fileId: string; storageKey: string; mime: string; byteLength: number; sha256: string };

export type PostCommentParams = {
  userId: string;
  requestId: string;
  body: string;
  attachments: CommentAttachment[];
};

export type PostCommentResult = { ok: true; commentId: string; mentions: string[] } | { ok: false; error: string };

export async function postComment(params: PostCommentParams): Promise<PostCommentResult> {
  const body = params.body.trim();
  if (!body) {
    return { ok: false, error: "Say something first." };
  }

  const resolved = await resolveViewerRole(params.userId, params.requestId);
  if (!resolved) {
    return { ok: false, error: "Request not found." };
  }
  const { role, request: req } = resolved;
  if (!CONVERSATION_ROLES.includes(role)) {
    return { ok: false, error: "This role can't post comments." };
  }

  return withGrantScope(params.userId, role, async (tx) => {
    // Mention candidates: anyone who could plausibly be pulled into this
    // request's conversation — the same reverse lookup phase 8's email
    // recipient resolution reuses unchanged.
    //
    // A plain sql`${CONVERSATION_ROLES}` interpolation gets flattened by
    // postgres.js into a parenthesised parameter list ($1, $2, ...) — the
    // shape it uses for an IN(...) clause, not a Postgres array literal.
    // Building an explicit ARRAY[...]::text[] via sql.join is what
    // actually produces a value app_users_with_scope's text[] parameter
    // accepts.
    const rolesArray = sql.join(
      CONVERSATION_ROLES.map((role) => sql`${role}`),
      sql`, `,
    );
    const scoped = await tx.execute<{ user_id: string }>(
      sql`select user_id from app_users_with_scope(ARRAY[${rolesArray}]::text[], ${req.departmentId}, ${req.companyId})`,
    );
    const candidateIds = scoped.map((row) => row.user_id);
    const candidates =
      candidateIds.length > 0 ? await tx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, candidateIds)) : [];
    const mentions = resolveMentions(body, candidates);

    const [inserted] = await tx
      .insert(comment)
      .values({ requestId: req.id, author: params.userId, roleAtTime: role, body, mentions })
      .returning({ id: comment.id });

    for (const [i, attachment] of params.attachments.entries()) {
      await tx.insert(requestFile).values({
        id: attachment.fileId,
        requestId: req.id,
        kind: "comment_attachment",
        commentId: inserted.id,
        pageNo: i + 1,
        storageKey: attachment.storageKey,
        mime: attachment.mime,
        bytes: attachment.byteLength,
        sha256: attachment.sha256,
        uploadedBy: params.userId,
      });
    }

    return { ok: true, commentId: inserted.id, mentions };
  });
}
