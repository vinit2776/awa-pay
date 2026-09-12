import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY } from "./env";
import { parseExtractedFields, type ExtractedFields } from "./schema";

// AGENTS.md names these by their shorthand ("claude-haiku-4-5",
// "claude-sonnet-5"); these are the actual model identifiers the API
// accepts.
export const HAIKU_MODEL = "claude-haiku-4-5-20251001";
export const SONNET_MODEL = "claude-sonnet-5";

const MAX_TOKENS = 1024;

const EXTRACTION_TOOL = {
  name: "submit_extraction",
  description: "Report every field read off the bill, each with a 0 to 1 confidence.",
  input_schema: {
    type: "object" as const,
    properties: {
      vendor: fieldSchema("string", "The vendor/supplier name printed on the bill."),
      amount: fieldSchema("number", "The total payable amount, in rupees (major units, not paise) — e.g. 184500 for ₹1,84,500. Null if unreadable."),
      invoiceNo: fieldSchema("string", "The invoice/bill number as printed."),
      invoiceDate: fieldSchema("string", "The invoice date as an ISO date, YYYY-MM-DD."),
      gstin: fieldSchema("string", "The GSTIN printed on the bill, if any."),
    },
    required: ["vendor", "amount", "invoiceNo", "invoiceDate", "gstin"],
  },
};

function fieldSchema(valueType: "string" | "number", description: string) {
  return {
    type: "object" as const,
    description,
    properties: {
      value: { type: [valueType, "null"] as unknown as string },
      confidence: { type: "number" as const, minimum: 0, maximum: 1 },
    },
    required: ["value", "confidence"],
  };
}

export class ExtractionApiError extends Error {}

// Zero decision logic here — one call, one model, returns whatever the
// model reported or throws. extractCore.ts owns validation, escalation and
// what happens on failure; this file only knows how to talk to Anthropic.
export async function callModel(model: string, imageBase64: string, mime: string): Promise<ExtractedFields> {
  if (!ANTHROPIC_API_KEY) {
    throw new ExtractionApiError("ANTHROPIC_API_KEY is not configured.");
  }

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const documentBlock =
    mime === "application/pdf"
      ? { type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data: imageBase64 } }
      : { type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: imageBase64 } };

  let response;
  try {
    response = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      tools: [EXTRACTION_TOOL],
      tool_choice: { type: "tool", name: "submit_extraction" },
      messages: [
        {
          role: "user",
          content: [documentBlock, { type: "text", text: "Read this bill and report every field via submit_extraction." }],
        },
      ],
    });
  } catch (err) {
    throw new ExtractionApiError(err instanceof Error ? err.message : "Anthropic API call failed.");
  }

  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new ExtractionApiError("Model did not return a tool call.");
  }

  const fields = parseExtractedFields(toolUse.input);
  if (!fields) {
    throw new ExtractionApiError("Model's response did not match the expected shape.");
  }
  return fields;
}
