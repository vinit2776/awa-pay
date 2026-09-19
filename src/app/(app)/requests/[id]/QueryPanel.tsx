"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { answerQueryAction, raiseQueryAction } from "./actions";

export type OpenQuery = {
  id: string;
  question: string;
  directedAt: string[];
  directedUsers: { id: string; name: string }[];
  raisedByName: string;
  at: string;
};

// A person a query can be aimed at, as the request page resolved them
// server-side (raiseQuery re-validates every id it receives).
export type QueryPerson = { id: string; name: string; roles: string[]; raisedThis: boolean; acted: boolean };

const DIRECTABLE_ROLES: { value: "requester" | "approver" | "accountant" | "payer"; label: string }[] = [
  { value: "requester", label: "Requester" },
  { value: "approver", label: "Approver" },
  { value: "accountant", label: "Accountant" },
  { value: "payer", label: "Payer" },
];

type DirectableRole = (typeof DIRECTABLE_ROLES)[number]["value"];

// What a fresh composer starts with. An approver or accountant asking is
// almost always asking whoever raised the bill, so that person is
// pre-selected (by name, not the whole Requester pool). Everyone else keeps
// the role default.
function initialTargets(viewerRole: string, viewerId: string, raisedById: string, people: QueryPerson[]) {
  if ((viewerRole === "approver" || viewerRole === "accountant") && raisedById !== viewerId && people.some((p) => p.id === raisedById)) {
    return { roles: [] as DirectableRole[], userIds: [raisedById] };
  }
  return { roles: [(viewerRole === "payer" ? "accountant" : "approver") as DirectableRole], userIds: [] as string[] };
}

function askedLabel(q: OpenQuery): string {
  return [...q.directedUsers.map((u) => u.name), ...q.directedAt.map((r) => `any ${r}`)].join(", ");
}

function personTag(p: QueryPerson): string {
  const role = p.roles.join(", ");
  return p.raisedThis ? `raised this bill · ${role}` : role;
}

export function QueryPanel({
  requestId,
  viewerId,
  viewerRole,
  raisedById,
  people,
  openQueries,
}: {
  requestId: string;
  viewerId: string;
  viewerRole: string;
  raisedById: string;
  people: QueryPerson[];
  openQueries: OpenQuery[];
}) {
  const router = useRouter();
  const [composing, setComposing] = useState(false);
  const [question, setQuestion] = useState("");
  const [directedAt, setDirectedAt] = useState<DirectableRole[]>([]);
  const [directedUserIds, setDirectedUserIds] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startComposing() {
    const initial = initialTargets(viewerRole, viewerId, raisedById, people);
    setDirectedAt(initial.roles);
    setDirectedUserIds(initial.userIds);
    setComposing(true);
  }

  function toggleRole(value: DirectableRole) {
    setDirectedAt((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
  }

  function toggleUser(id: string) {
    setDirectedUserIds((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));
  }

  async function submitQuery() {
    setPending(true);
    setError(null);
    const result = await raiseQueryAction(requestId, { directedAt, directedUserIds, question });
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

  const onRequest = people.filter((p) => p.raisedThis || p.acted);
  const inDepartment = people.filter((p) => !p.raisedThis && !p.acted);
  const nothingChosen = directedAt.length === 0 && directedUserIds.length === 0;

  function personCheckbox(p: QueryPerson) {
    return (
      <label key={p.id} className="flex items-center gap-1">
        <input type="checkbox" checked={directedUserIds.includes(p.id)} onChange={() => toggleUser(p.id)} />
        {p.name} <span className="text-zinc-500 dark:text-zinc-500">({personTag(p)})</span>
      </label>
    );
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
                <span className="font-medium">{q.raisedByName}</span>: {q.question}
              </p>
              <p className="text-xs text-zinc-600 dark:text-zinc-400">asked: {askedLabel(q)}</p>
              {(q.directedAt.includes(viewerRole) || q.directedUsers.some((u) => u.id === viewerId)) && (
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
        <div className="flex flex-col gap-3">
          <fieldset className="flex flex-col gap-1 text-sm">
            <legend className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Anyone holding a role</legend>
            <div className="flex flex-wrap gap-3">
              {DIRECTABLE_ROLES.map((r) => (
                <label key={r.value} className="flex items-center gap-1">
                  <input type="checkbox" checked={directedAt.includes(r.value)} onChange={() => toggleRole(r.value)} />
                  {r.label}
                </label>
              ))}
            </div>
          </fieldset>

          {onRequest.length > 0 && (
            <fieldset className="flex flex-col gap-1 text-sm">
              <legend className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Or a specific person, on this request</legend>
              {onRequest.map(personCheckbox)}
            </fieldset>
          )}
          {inDepartment.length > 0 && (
            <fieldset className="flex flex-col gap-1 text-sm">
              <legend className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Or someone else in the department</legend>
              {inDepartment.map(personCheckbox)}
            </fieldset>
          )}

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
              disabled={pending || !question.trim() || nothingChosen}
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
          onClick={startComposing}
          className="self-start rounded border border-amber-400 px-3 py-1.5 text-sm font-medium text-amber-700 dark:border-amber-700 dark:text-amber-400"
        >
          Raise a query
        </button>
      )}
    </div>
  );
}
