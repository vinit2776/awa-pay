"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { answerQueryAction, raiseQueryAction } from "./actions";

export type OpenQuery = { id: string; question: string; directedAt: string[]; raisedByName: string; at: string };

const DIRECTABLE_ROLES: { value: "requester" | "approver"; label: string }[] = [
  { value: "requester", label: "Requester" },
  { value: "approver", label: "Approver" },
];

export function QueryPanel({ requestId, viewerRole, openQueries }: { requestId: string; viewerRole: string; openQueries: OpenQuery[] }) {
  const router = useRouter();
  const [composing, setComposing] = useState(false);
  const [question, setQuestion] = useState("");
  const [directedAt, setDirectedAt] = useState<string[]>(["approver"]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleDirectedAt(value: string) {
    setDirectedAt((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
  }

  async function submitQuery() {
    setPending(true);
    setError(null);
    const result = await raiseQueryAction(requestId, { directedAt: directedAt as ("requester" | "approver")[], question });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setQuestion("");
    setComposing(false);
    router.refresh();
  }

  async function submitAnswer(queryId: string) {
    setPending(true);
    setError(null);
    const result = await answerQueryAction(requestId, queryId, { answer: answers[queryId] ?? "" });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3 rounded border border-amber-400 p-4 dark:border-amber-700">
      <h2 className="text-sm font-medium">Queries</h2>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {openQueries.length > 0 && (
        <ul className="flex flex-col gap-3">
          {openQueries.map((q) => (
            <li key={q.id} className="flex flex-col gap-2 rounded border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
              <p className="text-sm">
                <span className="font-medium">{q.raisedByName}</span> asked ({q.directedAt.join(", ")}): {q.question}
              </p>
              {q.directedAt.includes(viewerRole) && (
                <div className="flex flex-col gap-2">
                  <textarea
                    value={answers[q.id] ?? ""}
                    onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                    placeholder="Answer this query"
                    rows={2}
                    className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
                  />
                  <button
                    type="button"
                    disabled={pending || !(answers[q.id] ?? "").trim()}
                    onClick={() => void submitAnswer(q.id)}
                    className="self-start rounded bg-black px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
                  >
                    Answer
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {composing ? (
        <div className="flex flex-col gap-2">
          <div className="flex gap-3 text-sm">
            {DIRECTABLE_ROLES.map((r) => (
              <label key={r.value} className="flex items-center gap-1">
                <input type="checkbox" checked={directedAt.includes(r.value)} onChange={() => toggleDirectedAt(r.value)} />
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
              onClick={() => void submitQuery()}
              className="rounded bg-black px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
            >
              {pending ? "Sending…" : "Send query"}
            </button>
            <button type="button" onClick={() => setComposing(false)} className="rounded border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setComposing(true)}
          className="self-start rounded border border-amber-400 px-3 py-1.5 text-sm font-medium text-amber-700 dark:border-amber-700 dark:text-amber-400"
        >
          Raise a query
        </button>
      )}
    </div>
  );
}
