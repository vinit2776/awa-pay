"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { raiseQueryAction } from "./requests/[id]/actions";

const ROLES = [
  { value: "requester", label: "Requester" },
  { value: "approver", label: "Approver" },
] as const;

// Raise a query on a request without opening it. The same action and the
// same rules as the Queries panel on the record: it freezes the request
// where it stands and leaves ownership unchanged.
export function QueueQueryButton({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [directedAt, setDirectedAt] = useState<("requester" | "approver")[]>(["approver"]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setPending(true);
    setError(null);
    const result = await raiseQueryAction(requestId, { directedAt, question });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOpen(false);
    setQuestion("");
    router.refresh();
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-xs underline">
        Raise a query
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex gap-3 text-xs">
        {ROLES.map((r) => (
          <label key={r.value} className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={directedAt.includes(r.value)}
              onChange={() => setDirectedAt((prev) => (prev.includes(r.value) ? prev.filter((v) => v !== r.value) : [...prev, r.value]))}
            />
            {r.label}
          </label>
        ))}
      </div>
      <textarea
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="What do you need to know before this can move forward?"
        rows={2}
        className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
      />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending || !question.trim() || directedAt.length === 0}
          onClick={() => void send()}
          className="rounded bg-black px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
        >
          {pending ? "Sending…" : "Send query"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded border border-zinc-300 px-3 py-1.5 text-xs dark:border-zinc-700">
          Cancel
        </button>
      </div>
    </div>
  );
}
