import { describe, expect, it } from "vitest";
import { isUndeliverableAddress, splitDeliverable } from "../src/notifications/recipientFilter";

// Pure — no database. Guards the dev-side harm the test-fixture pile caused:
// real mail (with a live RESEND_API_KEY) to addresses that can only bounce.
describe("undeliverable recipient filter", () => {
  it.each([
    "desks-test-accountant-140c5f1c@example.invalid",
    "approver@awa-pay.test",
    "someone@localhost",
    "a@b.example",
    "a@example.com",
    "a@mail.example.org",
    "A@EXAMPLE.INVALID",
    "not-an-address",
  ])("drops %s", (address) => {
    expect(isUndeliverableAddress(address)).toBe(true);
  });

  it.each(["accounts@awa-manufacturing.in", "vinitchordia@gmail.com", "x@sub.company.co.in", "test@testing.com", "a@notexample.com"])("keeps %s", (address) => {
    expect(isUndeliverableAddress(address)).toBe(false);
  });

  it("splits a mixed list and preserves order", () => {
    expect(splitDeliverable(["a@example.invalid", "real@company.in", "b@awa-pay.test", "other@company.in"])).toEqual({
      deliverable: ["real@company.in", "other@company.in"],
      dropped: ["a@example.invalid", "b@awa-pay.test"],
    });
  });
});
