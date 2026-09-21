import { describe, expect, it } from "vitest";
import { fieldsToConfirm, isLowConfidence, unconfirmedFields } from "@/capture/confirmFields";
import { CONFIDENCE_FLOORS } from "@/extraction/confidenceFloors";

// Pure — no database.
describe("confirm fields", () => {
  it("uses the server's escalation floors for decisive fields", () => {
    expect(isLowConfidence("amount", CONFIDENCE_FLOORS.amount - 0.01)).toBe(true);
    expect(isLowConfidence("amount", CONFIDENCE_FLOORS.amount)).toBe(false);
    expect(isLowConfidence("vendor", CONFIDENCE_FLOORS.vendor - 0.01)).toBe(true);
  });

  it("uses 0.8 for badge-only fields", () => {
    expect(isLowConfidence("invoiceDate", 0.79)).toBe(true);
    expect(isLowConfidence("gstin", 0.8)).toBe(false);
  });

  it("treats a field the model never read as not needing confirmation", () => {
    expect(isLowConfidence("amount", undefined)).toBe(false);
  });

  it("lists only low-confidence fields not yet confirmed", () => {
    const confidence = { amount: 0.99, vendor: 0.5, invoiceDate: 0.4 };
    expect(unconfirmedFields(confidence, new Set())).toEqual(["vendor", "invoiceDate"]);
    expect(unconfirmedFields(confidence, new Set(["vendor"] as const))).toEqual(["invoiceDate"]);
  });

  it("gates only the fields the details step shows for that kind", () => {
    const confidence = { vendor: 0.4, invoiceDate: 0.4, gstin: 0.1 };
    expect(unconfirmedFields(confidence, new Set(), fieldsToConfirm("invoice"))).toEqual(["vendor", "invoiceDate"]);
    // An advance has no bill date yet, and GSTIN is never a gate.
    expect(unconfirmedFields(confidence, new Set(), fieldsToConfirm("advance"))).toEqual(["vendor"]);
  });
});
