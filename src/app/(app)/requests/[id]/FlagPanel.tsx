"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { clearManualFlagAction, raiseManualFlagAction } from "./actions";

export type OpenFlag = { id: string; reason: string; raisedByName: string; raisedAsRole: string; at: string };

// Manual flags: "a person looked at this and something is off". Everyone who
// can see the request sees the open flags; the three desks can raise and
// clear them. A flag never moves or freezes the request (that is a query).
export function FlagPanel({ requestId, flags, canAct }: { requestId: string; flags: OpenFlag[]; canAct: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setPending(true);
    setError(null);
    const result = await fn();
    setPending(false);
    if (!result.ok) {
      setError(result.error ?? "That didn't work.");
      return;
    }
    setOpen(false);
    setReason("");
    router.refresh();
  }

  if (flags.length === 0 && !canAct) return null;

  return (
    <div className="flex flex-col gap-2 rounded border border-red-300 p-3 text-sm dark:border-red-900">
      <h2 className="text-sm font-medium">Flags</h2>
      {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
      {flags.length === 0 && <p className="text-zinc-600 dark:text-zinc-400">No open flags.</p>}
      <ul className="flex flex-col gap-2">
        {flags.map((f) => (
          <li key={f.id} className="flex items-start justify-between gap-3">
            <span>
              <span className="mr-1 inline-block h-[7px] w-[7px] rounded-full bg-red-500 align-middle dark:bg-red-400" />
              {f.reason}
              <span className="block text-xs text-zinc-500">
                {f.raisedByName} ({f.raisedAsRole}) · {new Date(f.at).toLocaleString()}
              </span>
            </span>
            {canAct && (
              <button type="button" disabled={pending} onClick={() => void run(() => clearManualFlagAction(requestId, f.id))} className="shrink-0 text-xs underline disabled:opacity-50">
                Clear
              </button>
            )}
          </li>
        ))}
      </ul>
      {canAct &&
        (open ? (
          <div className="flex flex-col gap-2">
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="What looks wrong? e.g. bank details differ from the bill"
              rows={2}
              className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-black"
            />
            <div className="flex gap-2">
              <button
                type="button"
                disabled={pending || !reason.trim()}
                onClick={() => void run(() => raiseManualFlagAction(requestId, { reason }))}
                className="rounded bg-black px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
              >
                Flag
              </button>
              <button type="button" onClick={() => setOpen(false)} className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setOpen(true)} className="self-start text-xs underline">
            Flag this request
          </button>
        ))}
    </div>
  );
}
