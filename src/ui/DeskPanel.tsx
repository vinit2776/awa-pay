import type { ReactNode } from "react";
import { Notice } from "./Notice";

// The "your move" block on a request record: the one place the owning
// desk acts. While a query is open (`frozenReason`) the controls inside
// are disabled through a native <fieldset disabled>, matching
// runTransition's own freeze on the server — the server remains the
// actual enforcement, this only stops people filling a form it will refuse.
export function DeskPanel({
  title,
  aside,
  frozenReason,
  children,
}: {
  title: string;
  aside?: ReactNode;
  frozenReason?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={`overflow-hidden rounded-xl border bg-surface ${frozenReason ? "border-line" : "border-accent ring-3 ring-accent-soft"}`}
    >
      <header className="flex items-center justify-between gap-2 border-b border-line-soft px-3.5 py-2.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {aside}
      </header>
      <div className="flex flex-col gap-3 p-3.5">
        {frozenReason && <Notice tone="warn" title="Paused by an open query">{frozenReason}</Notice>}
        <fieldset disabled={!!frozenReason} className="flex min-w-0 flex-col gap-3 disabled:opacity-60">
          {children}
        </fieldset>
      </div>
    </section>
  );
}
