"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { mergeTimeline, type TimelineEntry } from "@/requests/timeline";
import { buttonClass, eyebrowClass, inputClass, labelClass } from "@/ui/styles";
import type { CommentAttachment } from "@/conversation/commentsCore";
import { answerQueryAction, postCommentAction, raiseQueryAction, requestCommentAttachmentUploadSlot, sendNudgeAction } from "./actions";

async function sha256Hex(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const DIRECTABLE_ROLES: { value: "requester" | "approver"; label: string }[] = [
  { value: "requester", label: "the requester" },
  { value: "approver", label: "the approver" },
];

function when(at: string): string {
  return new Date(at).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

// Trail, comments and queries in one list — three tables, one story. The
// composer, the nudge and answering a query all live here too, so there's
// one place a person reads and one place they write.
export function Timeline({
  requestId,
  viewerRole,
  entries,
  canNudge,
}: {
  requestId: string;
  viewerRole: string;
  entries: TimelineEntry[];
  canNudge: boolean;
}) {
  const router = useRouter();
  const merged = mergeTimeline(entries);
  const [body, setBody] = useState("");
  const [attachments, setAttachments] = useState<CommentAttachment[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [question, setQuestion] = useState("");
  const [directedAt, setDirectedAt] = useState<string[]>(["approver"]);
  const [asking, setAsking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [pending, setPending] = useState(false);
  const [nudging, setNudging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setPending(true);
    setError(null);
    const result = await action();
    setPending(false);
    if (!result.ok) {
      setError(result.error ?? "Something went wrong.");
      return;
    }
    after?.();
    router.refresh();
  }

  async function attachFile(file: File) {
    setUploading(true);
    setError(null);
    try {
      const sha256 = await sha256Hex(file);
      const slot = await requestCommentAttachmentUploadSlot(file.type);
      if (!slot.ok) {
        setError(slot.error);
        return;
      }
      const putResponse = await fetch(slot.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
      if (!putResponse.ok) {
        setError("Upload failed.");
        return;
      }
      setAttachments((prev) => [...prev, { fileId: slot.fileId, storageKey: slot.storageKey, mime: file.type, byteLength: file.size, sha256 }]);
    } finally {
      setUploading(false);
    }
  }

  async function nudge() {
    setNudging(true);
    setError(null);
    const result = await sendNudgeAction(requestId);
    setNudging(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className={eyebrowClass}>History</h2>
        {canNudge && (
          <button type="button" disabled={nudging} onClick={() => void nudge()} className={buttonClass("ghost", "sm")}>
            {nudging ? "Nudging…" : "Nudge whoever has it"}
          </button>
        )}
      </div>

      <ol className="flex flex-col">
        {merged.map((e) => (
          <li key={`${e.kind}-${e.id}`} className="grid grid-cols-[14px_minmax(0,1fr)] gap-x-2.5 border-b border-line-soft py-2.5 last:border-b-0">
            <span
              aria-hidden
              className={`mt-1.5 size-2 rounded-full ${e.kind === "query" ? (e.resolvedAt ? "bg-ink-3" : "bg-warn") : e.kind === "comment" ? "bg-accent" : "bg-ink-3"}`}
            />
            <div className="flex min-w-0 flex-col gap-1">
              {e.kind === "event" && (
                <p className="text-[13px]">
                  <span className="font-semibold">{e.label}</span> <span className="text-ink-3">· {e.actorName} · {when(e.at)}</span>
                  {e.detail && <span className="text-ink-2"> · {e.detail}</span>}
                </p>
              )}

              {e.kind === "comment" && (
                <>
                  <p className="text-[13px]">
                    <span className="font-semibold">{e.authorName}</span> <span className="text-ink-3">· {e.roleAtTime} · {when(e.at)}</span>
                  </p>
                  <p className="rounded-lg bg-sunk px-2.5 py-2 text-[13px] wrap-anywhere">{e.body}</p>
                  {e.attachments.length > 0 && (
                    <ul className="flex flex-wrap gap-2">
                      {e.attachments.map((a) => (
                        <li key={a.id}>
                          <a href={a.downloadUrl} target="_blank" rel="noreferrer" className="text-xs text-accent hover:underline">
                            {a.mime === "application/pdf" ? "PDF attachment ↗" : "Photo ↗"}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}

              {e.kind === "query" && (
                <>
                  <p className="text-[13px]">
                    <span className="font-semibold">{e.raisedByName} asked {e.directedAt.join(" and ").replace(/_/g, " ")}</span>{" "}
                    <span className="text-ink-3">· {when(e.at)}</span>
                    {!e.resolvedAt && <span className="ml-1.5 font-cond text-[11.5px] font-semibold tracking-wide text-warn">WAITING</span>}
                  </p>
                  <p className={`rounded-lg px-2.5 py-2 text-[13px] wrap-anywhere ${e.resolvedAt ? "bg-sunk" : "border border-warn-line bg-warn-soft"}`}>
                    {e.question}
                  </p>
                  {e.answer && (
                    <p className="rounded-lg bg-sunk px-2.5 py-2 text-[13px] wrap-anywhere">
                      <span className="font-semibold">{e.answeredByName ?? "Answered"}:</span> {e.answer}
                    </p>
                  )}
                  {!e.resolvedAt && e.directedAt.includes(viewerRole) && (
                    <div className="flex flex-col gap-2 pt-1">
                      <label htmlFor={`answer-${e.id}`} className={labelClass}>
                        Your answer — this unfreezes the request
                      </label>
                      <textarea
                        id={`answer-${e.id}`}
                        value={answers[e.id] ?? ""}
                        onChange={(ev) => setAnswers((prev) => ({ ...prev, [e.id]: ev.target.value }))}
                        rows={2}
                        className={inputClass}
                      />
                      <button
                        type="button"
                        disabled={pending || !(answers[e.id] ?? "").trim()}
                        onClick={() => void run(() => answerQueryAction(requestId, e.id, { answer: answers[e.id] ?? "" }))}
                        className={`${buttonClass("primary", "sm")} self-start`}
                      >
                        Send answer to {e.raisedByName}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </li>
        ))}
        {merged.length === 0 && <li className="py-2 text-[13px] text-ink-3">Nothing has happened yet.</li>}
      </ol>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-2 border-t border-line-soft pt-3">
        <label htmlFor="comment-body" className={labelClass}>
          Add a comment <span className="font-normal text-ink-3">stays open even after the bill is paid</span>
        </label>
        <textarea id="comment-body" value={body} onChange={(e) => setBody(e.target.value)} rows={2} placeholder="@mention anyone to pull them in" className={inputClass} />
        {attachments.length > 0 && <span className="text-xs text-ink-3">{attachments.length} attachment(s) added</span>}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={pending || uploading || !body.trim()}
            onClick={() =>
              void run(
                () => postCommentAction(requestId, { body, attachments }),
                () => {
                  setBody("");
                  setAttachments([]);
                },
              )
            }
            className={buttonClass("primary", "sm")}
          >
            {pending ? "Posting…" : "Post"}
          </button>
          <label className={`${buttonClass("secondary", "sm")} cursor-pointer`}>
            {uploading ? "Attaching…" : "Attach"}
            <input
              type="file"
              accept="application/pdf,image/*"
              disabled={uploading}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void attachFile(file);
              }}
            />
          </label>
          {!asking && (
            <button type="button" onClick={() => setAsking(true)} className={buttonClass("secondary", "sm")}>
              Ask a question
            </button>
          )}
        </div>

        {asking && (
          <div className="flex flex-col gap-2 rounded-lg border border-warn-line bg-warn-soft p-3">
            <p className="text-[13px] font-semibold text-warn">A question freezes this request until it&apos;s answered</p>
            <div className="flex flex-wrap gap-3 text-[13px]">
              {DIRECTABLE_ROLES.map((r) => (
                <label key={r.value} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={directedAt.includes(r.value)}
                    onChange={() => setDirectedAt((prev) => (prev.includes(r.value) ? prev.filter((v) => v !== r.value) : [...prev, r.value]))}
                  />
                  Ask {r.label}
                </label>
              ))}
            </div>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={2}
              placeholder="What do you need to know before this can move forward?"
              className={inputClass}
            />
            <div className="flex gap-2">
              <button
                type="button"
                disabled={pending || !question.trim() || directedAt.length === 0}
                onClick={() =>
                  void run(
                    () => raiseQueryAction(requestId, { directedAt: directedAt as ("requester" | "approver")[], question }),
                    () => {
                      setQuestion("");
                      setAsking(false);
                    },
                  )
                }
                className={buttonClass("primary", "sm")}
              >
                {pending ? "Sending…" : "Send question"}
              </button>
              <button type="button" onClick={() => setAsking(false)} className={buttonClass("secondary", "sm")}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
