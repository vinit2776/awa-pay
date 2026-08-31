"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postCommentAction, requestCommentAttachmentUploadSlot } from "./actions";
import type { CommentAttachment } from "@/conversation/commentsCore";

async function sha256Hex(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type ConversationEntry = {
  id: string;
  authorName: string;
  roleAtTime: string;
  body: string;
  at: string;
  attachments: { id: string; mime: string; downloadUrl: string }[];
};

export function ConversationPanel({ requestId, entries }: { requestId: string; entries: ConversationEntry[] }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [attachments, setAttachments] = useState<CommentAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function post() {
    setPending(true);
    setError(null);
    const result = await postCommentAction(requestId, { body, attachments });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setBody("");
    setAttachments([]);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3 rounded border border-zinc-300 p-4 dark:border-zinc-700">
      <h2 className="text-sm font-medium">Conversation</h2>

      <ul className="flex flex-col gap-3">
        {entries.map((e) => (
          <li key={e.id} className="text-sm">
            <div className="flex items-baseline gap-2">
              <span className="font-medium">{e.authorName}</span>
              <span className="text-xs text-zinc-500 dark:text-zinc-500">{e.roleAtTime}</span>
              <span className="text-xs text-zinc-500 dark:text-zinc-500">{new Date(e.at).toLocaleString()}</span>
            </div>
            <p className="text-zinc-700 dark:text-zinc-300">{e.body}</p>
            {e.attachments.length > 0 && (
              <ul className="mt-1 flex flex-col gap-1">
                {e.attachments.map((a) => (
                  <li key={a.id}>
                    <a href={a.downloadUrl} target="_blank" rel="noreferrer" className="text-xs underline">
                      {a.mime === "application/pdf" ? "PDF attachment" : "photo attachment"}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
        {entries.length === 0 && <li className="text-sm text-zinc-500 dark:text-zinc-500">No comments yet.</li>}
      </ul>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Reply — @mention anyone to pull them in"
        rows={3}
        className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
      />

      {attachments.length > 0 && <span className="text-xs text-zinc-600 dark:text-zinc-400">{attachments.length} attachment(s) added</span>}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending || uploading || !body.trim()}
          onClick={() => void post()}
          className="flex-1 rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
        >
          {pending ? "Posting…" : "Post"}
        </button>
        <label className="flex cursor-pointer items-center rounded border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700">
          Attach
          <input
            type="file"
            accept="application/pdf,image/*"
            disabled={uploading}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void attachFile(file);
            }}
          />
        </label>
      </div>
    </div>
  );
}
