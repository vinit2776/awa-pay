import type { Flag } from "@/flags/computeFlags";
import { flagLabel } from "./flagLabel";

const SEVERITY: Record<Flag["severity"], string> = {
  red: "border-danger-line text-danger",
  amber: "border-warn-line text-warn",
};

export function FlagChips({ flags }: { flags: Flag[] }) {
  if (flags.length === 0) return null;
  return (
    <span className="ml-2 inline-flex flex-wrap items-center gap-1 align-middle">
      {flags.map((f) => (
        <span
          key={f.key}
          title={f.reason}
          className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 text-[11.5px] font-medium ${SEVERITY[f.severity]}`}
        >
          <span aria-hidden className="size-1.5 rounded-full bg-current" />
          {flagLabel(f)}
        </span>
      ))}
    </span>
  );
}
