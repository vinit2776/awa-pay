import { createHash } from "node:crypto";

// Genuine tamper-evidence, computed for real (not a stub): SHA-256 over a
// canonical JSON serialization of the event's own content plus prevHash.
// A post-hoc edit to what was written won't reproduce this hash on
// recomputation.
//
// Chaining is per-request, not global: prevHash is the hash of the
// previous event for that same request_id, or null if none exists. A
// single global chain would serialize every unrelated request's writes
// through one shared tail pointer — real lock/concurrency design this
// codebase has nothing built for. Per-request chains have zero
// cross-request contention.
//
// What's deliberately not built yet: the "look up the previous event for
// this request" query, and any concurrency handling for concurrent
// writers to the same request's chain. request.raised (the only event
// type phase 3 writes) is always the first event a new request gets, so
// prevHash is unambiguously null at that one call site. This becomes real
// the moment a second event type on a request exists (phase 4's
// approve/decline).
export type EventHashFields = {
  requestId: string | null;
  actor: string;
  roleAtTime: string;
  type: string;
  objectType: string;
  objectId: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
};

// Plain JSON.stringify is order-sensitive to object key insertion order.
// Postgres jsonb does not preserve that order on read-back, so recomputing
// a hash from a row fetched via SELECT (exactly what verifying the chain
// requires) would not reproduce the hash computed before insert, even
// though nothing was tampered with. Sorting object keys recursively makes
// the serialization deterministic regardless of jsonb's own ordering.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

export function computeEventHash(fields: EventHashFields, prevHash: string | null): string {
  const canonical = JSON.stringify(canonicalize({ ...fields, prevHash }));
  return createHash("sha256").update(canonical).digest("hex");
}
