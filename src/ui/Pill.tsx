import type { ReactNode } from "react";
import type { Tone } from "./stages";

const TONE: Record<Tone, string> = {
  neutral: "bg-sunk text-ink-2",
  info: "bg-info-soft text-info",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
};

export function Pill({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 font-cond text-[11.5px] font-semibold tracking-wide ${TONE[tone]}`}>
      {children}
    </span>
  );
}
