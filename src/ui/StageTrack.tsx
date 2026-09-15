import { STAGE_LABEL, STAGE_TONE, stageTrack, type Stage, type StepState } from "./stages";
import { Pill } from "./Pill";

const BAR: Record<StepState, string> = {
  done: "bg-accent",
  current: "bg-accent ring-3 ring-accent-soft",
  paused: "bg-warn ring-3 ring-warn-soft",
  stopped: "bg-danger",
  todo: "bg-line",
};

// The full track, for the request record and the "sent" screen. `note`
// is appended to the current step's label, e.g. "you" or an owner's name.
export function StageTrack({ stage, frozen, note }: { stage: Stage; frozen?: boolean; note?: string }) {
  const steps = stageTrack(stage, { frozen });
  return (
    <ol className="grid grid-cols-5 gap-1" aria-label={`Stage: ${STAGE_LABEL[stage]}`}>
      {steps.map((s) => {
        const active = s.state === "current" || s.state === "paused" || s.state === "stopped";
        return (
          <li key={s.stage} className="flex flex-col gap-1.5" aria-current={active ? "step" : undefined}>
            <span className={`h-1 rounded-full ${BAR[s.state]}`} />
            <span className={`font-cond text-[11px] leading-tight tracking-wide ${active ? "font-semibold text-ink" : "text-ink-3"}`}>
              {s.label}
              {active && note && <> · {note}</>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

const MINI: Record<StepState, string> = {
  done: "bg-accent",
  current: "bg-accent",
  paused: "bg-warn",
  stopped: "bg-danger",
  todo: "bg-line",
};

// Five short bars for list rows, with the stage name for screen readers.
export function MiniTrack({ stage, frozen }: { stage: Stage; frozen?: boolean }) {
  return (
    <span className="inline-grid grid-cols-5 gap-0.5 align-middle" role="img" aria-label={STAGE_LABEL[stage]}>
      {stageTrack(stage, { frozen }).map((s) => (
        <i key={s.stage} className={`h-1 w-3.5 rounded-full ${MINI[s.state]}`} />
      ))}
    </span>
  );
}

export function StagePill({ stage }: { stage: Stage }) {
  return <Pill tone={STAGE_TONE[stage]}>{STAGE_LABEL[stage]}</Pill>;
}
