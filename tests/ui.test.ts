import { describe, expect, it } from "vitest";
import { requestStageEnum } from "@/db/schema/enums";
import type { Flag } from "@/flags/computeFlags";
import { flagLabel } from "@/ui/flagLabel";
import { activeHref, buildNavItems } from "@/ui/shell/nav";
import { STAGES, stageTrack } from "@/ui/stages";

// Pure display rules only — no database, so these run in milliseconds
// alongside the Postgres-backed suites.

describe("stages", () => {
  it("covers exactly the stages the database knows", () => {
    expect([...STAGES].sort()).toEqual([...requestStageEnum.enumValues].sort());
  });

  it("marks earlier steps done and the current one current", () => {
    expect(stageTrack("with_accounts").map((s) => s.state)).toEqual(["done", "done", "current", "todo", "todo"]);
  });

  it("reads an open query as paused without moving the stage", () => {
    expect(stageTrack("with_accounts", { frozen: true })[2]).toMatchObject({ stage: "with_accounts", state: "paused" });
  });

  it("completes every step once paid", () => {
    expect(stageTrack("paid").every((s) => s.state === "done")).toBe(true);
  });

  it("places hold and reject on the approval step, withdraw on raised", () => {
    expect(stageTrack("on_hold")[1]).toMatchObject({ label: "On hold", state: "paused" });
    expect(stageTrack("rejected")[1]).toMatchObject({ label: "Rejected", state: "stopped" });
    expect(stageTrack("rejected")[2].state).toBe("todo");
    expect(stageTrack("withdrawn")[0]).toMatchObject({ label: "Withdrawn", state: "stopped" });
  });
});

describe("flag labels", () => {
  const flag = (key: Flag["key"], reason: string): Flag => ({ key, severity: "amber", reason });

  it("shortens ageing to its day count", () => {
    expect(flagLabel(flag("ageing", "Waiting 12 days — past this department's 7-day threshold"))).toBe("Aged 12d");
  });

  it("keeps the due-date reason, which is already short", () => {
    expect(flagLabel(flag("due_soon", "Due in 2 days"))).toBe("Due in 2 days");
  });

  it("labels the rest by kind", () => {
    expect(flagLabel(flag("unanswered_query", "x"))).toBe("Query open");
    expect(flagLabel(flag("repeat_amount", "x"))).toBe("Repeat amount");
    expect(flagLabel(flag("bank_changed", "x"))).toBe("Bank unverified");
  });
});

describe("nav", () => {
  it("builds tabs only for held roles, in the order a bill travels", () => {
    const items = buildNavItems(new Set(["payer", "requester"]), { requester: 2, payer: 4 });
    expect(items.map((i) => i.href)).toEqual(["/", "/requests/new", "/requests", "/payments"]);
    expect(items.find((i) => i.href === "/requests")?.count).toBe(2);
  });

  it("gives super admins and developers only Home", () => {
    expect(buildNavItems(new Set(["super_admin", "developer"]), {}).map((i) => i.href)).toEqual(["/"]);
  });

  it("highlights the longest matching tab", () => {
    const hrefs = ["/", "/requests/new", "/requests", "/approvals"];
    expect(activeHref("/", hrefs)).toBe("/");
    expect(activeHref("/requests/new", hrefs)).toBe("/requests/new");
    expect(activeHref("/requests/abc-123", hrefs)).toBe("/requests");
    expect(activeHref("/approvals", hrefs)).toBe("/approvals");
    expect(activeHref("/vendors/x", hrefs)).toBeNull();
  });
});
