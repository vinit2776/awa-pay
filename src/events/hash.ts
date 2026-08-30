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

export function computeEventHash(fields: EventHashFields, prevHash: string | null): string {
  const canonical = JSON.stringify({ ...fields, prevHash });
  return createHash("sha256").update(canonical).digest("hex");
}
