import { describe, expect, it } from "vitest";
import { comparePayments, daysSince, groupRows, needsRequesterReason, stageEnteredAt } from "@/requests/queueRows";

// Pure — no database.

const d = (iso: string) => new Date(iso);

describe("stage clock", () => {
  it("starts at the latest stage-moving event", () => {
    const events = [
      { type: "request.raised", at: d("2026-09-01T09:00:00Z") },
      { type: "request.approved", at: d("2026-09-05T09:00:00Z") },
    ];
    expect(stageEnteredAt(events, d("2026-09-01T08:00:00Z"))).toEqual(d("2026-09-05T09:00:00Z"));
  });

  it("isn't reset by a query, an answer or a nudge", () => {
    const events = [
      { type: "request.approved", at: d("2026-09-05T09:00:00Z") },
      { type: "request.query_raised", at: d("2026-09-10T09:00:00Z") },
      { type: "request.nudged", at: d("2026-09-11T09:00:00Z") },
    ];
    expect(stageEnteredAt(events, d("2026-09-01T08:00:00Z"))).toEqual(d("2026-09-05T09:00:00Z"));
  });

  it("falls back to when the request was created", () => {
    expect(stageEnteredAt([], d("2026-09-01T08:00:00Z"))).toEqual(d("2026-09-01T08:00:00Z"));
  });

  it("counts whole days, never negative", () => {
    expect(daysSince(d("2026-09-05T09:00:00Z"), d("2026-09-16T08:00:00Z"))).toBe(10);
    expect(daysSince(d("2026-09-17T09:00:00Z"), d("2026-09-16T08:00:00Z"))).toBe(0);
  });
});

describe("payer order", () => {
  it("puts immediate first, then dated by due date, then payer decides", () => {
    const rows = [
      { id: "later", cycle: "dated", dueDate: "2026-09-30" },
      { id: "free", cycle: "unspecified", dueDate: null },
      { id: "now", cycle: "immediate", dueDate: null },
      { id: "soon", cycle: "dated", dueDate: "2026-09-18" },
    ];
    expect([...rows].sort(comparePayments).map((r) => r.id)).toEqual(["now", "soon", "later", "free"]);
  });
});

describe("grouping", () => {
  it("keeps first-seen order, or follows an explicit order", () => {
    const rows = [{ g: "b" }, { g: "a" }, { g: "b" }];
    expect(groupRows(rows, (r) => r.g).map((x) => [x.key, x.rows.length])).toEqual([
      ["b", 2],
      ["a", 1],
    ]);
    expect(groupRows(rows, (r) => r.g, ["a", "b"]).map((x) => x.key)).toEqual(["a", "b"]);
  });
});

describe("needs the requester", () => {
  it("prefers an open question over a return", () => {
    expect(needsRequesterReason({ stage: "raised", returnReason: "GSTIN missing", openQuery: { raisedByName: "R. Iyer", question: "Plant 2?" } })).toBe(
      "Question from R. Iyer: “Plant 2?”",
    );
  });

  it("quotes the return reason for a bill sent back", () => {
    expect(needsRequesterReason({ stage: "raised", returnReason: "GSTIN missing", openQuery: null })).toBe("Returned: “GSTIN missing”");
  });

  it("asks for the tax invoice once an advance has gone out", () => {
    expect(needsRequesterReason({ stage: "awaiting_invoice", returnReason: null, openQuery: null })).toMatch(/attach the tax invoice/);
  });

  it("is null for anything moving without them", () => {
    expect(needsRequesterReason({ stage: "with_accounts", returnReason: null, openQuery: null })).toBeNull();
  });
});
