import type { Flag } from "@/flags/computeFlags";

// A short, always-visible label for a computed flag. The full reason
// stays available as the chip's title — the old dots showed only the
// title, which never appears on a phone.
export function flagLabel(flag: Flag): string {
  switch (flag.key) {
    case "ageing": {
      const days = /Waiting (\d+) days/.exec(flag.reason)?.[1];
      return days ? `Aged ${days}d` : "Aged";
    }
    case "unanswered_query":
      return "Query open";
    case "due_soon":
      return flag.reason;
    case "repeat_amount":
      return "Repeat amount";
    case "bank_changed":
      return "Bank unverified";
  }
}
