import type { ReactNode } from "react";

type NoticeTone = "warn" | "danger" | "info" | "ok";

const TONE: Record<NoticeTone, { box: string; title: string }> = {
  warn: { box: "border-warn-line bg-warn-soft", title: "text-warn" },
  danger: { box: "border-danger-line bg-danger-soft", title: "text-danger" },
  info: { box: "border-transparent bg-info-soft", title: "text-info" },
  ok: { box: "border-transparent bg-ok-soft", title: "text-ok" },
};

// A boxed message: duplicate warnings, offline, queries, returns.
export function Notice({ tone, title, children }: { tone: NoticeTone; title: string; children?: ReactNode }) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`flex flex-col gap-1 rounded-lg border px-3 py-2.5 text-[13px] text-ink ${TONE[tone].box}`}>
      <p className={`font-semibold ${TONE[tone].title}`}>{title}</p>
      {children}
    </div>
  );
}
