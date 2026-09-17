import type { ReactNode } from "react";

export function QueueHeader({ title, summary, action }: { title: string; summary?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex flex-col gap-0.5">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {summary && <p className="text-sm text-ink-2">{summary}</p>}
      </div>
      {action}
    </div>
  );
}
