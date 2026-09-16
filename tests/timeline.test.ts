import { describe, expect, it } from "vitest";
import { freezeReason, mergeTimeline, openQueries, type TimelineEntry } from "@/requests/timeline";

// Pure — no database.

const event = (id: string, at: string): TimelineEntry => ({ kind: "event", id, at, actorName: "R. Iyer", icon: "✓", label: "Approved", detail: "" });
const comment = (id: string, at: string): TimelineEntry => ({
  kind: "comment",
  id,
  at,
  authorName: "S. Patil",
  roleAtTime: "requester",
  body: "Panel B, not panel A.",
  attachments: [],
});
const query = (id: string, at: string, resolvedAt: string | null): TimelineEntry => ({
  kind: "query",
  id,
  at,
  raisedByName: "R. Iyer",
  question: "Plant 2 or the warehouse?",
  directedAt: ["requester"],
  answer: resolvedAt ? "Plant 2." : null,
  answeredByName: resolvedAt ? "S. Patil" : null,
  resolvedAt,
});

describe("timeline", () => {
  it("reads oldest first, whatever order the tables came back in", () => {
    const merged = mergeTimeline([comment("c", "2026-09-15T10:02:00Z"), event("e", "2026-09-15T09:43:00Z")]);
    expect(merged.map((e) => e.id)).toEqual(["e", "c"]);
  });

  it("puts the transition before the query and comment that share its timestamp", () => {
    const at = "2026-09-15T09:43:00Z";
    const merged = mergeTimeline([comment("c", at), query("q", at, null), event("e", at)]);
    expect(merged.map((e) => e.id)).toEqual(["e", "q", "c"]);
  });

  it("counts only unanswered queries as freezing the request", () => {
    const entries = [query("open", "2026-09-15T09:00:00Z", null), query("done", "2026-09-14T09:00:00Z", "2026-09-14T10:00:00Z")];
    expect(openQueries(entries).map((q) => q.id)).toEqual(["open"]);
  });

  it("says who is being waited on", () => {
    const open = openQueries([query("q", "2026-09-15T09:00:00Z", null)]);
    expect(freezeReason(open)).toBe("R. Iyer asked the requester: “Plant 2 or the warehouse?”");
    expect(freezeReason([])).toBeNull();
  });
});
