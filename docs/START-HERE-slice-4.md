# Start here — handoff for slice 4

You are picking up a project with slices 1–3 complete: auth, capture, the four desks, the full conversation layer, and the vendor master with payer verification, duplicate control and computed flags are all merged. This document is the state of play and the order of work for slice 4 — the last of the four planned slices. Read it, then re-read `AGENTS.md`, then open `docs/concept-v2.html` sections 02 (mobile capture), 12 (health console), 13 (reports), 15 (data model), 16 (infra layers) and 17 (stack carryover) in a browser.

Nothing here needs to be recovered from a conversation. If something is not written down in this repository, it was not decided.

---

## Slice 4, in one sentence

Everything in this slice is an accelerator on a flow that already works without it: a bill's headline fields are read automatically and shown for confirmation rather than typed from scratch, a capture with no signal queues itself and sends when it can, a stage handover reaches an installed phone immediately rather than waiting on email alone, the machine's own health (extraction accuracy, escalation rate, abandonment, push delivery) is visible to whoever can fix it without ever showing an amount, and the money's own shape — ageing, cycle time, spend, control exceptions — is one click away instead of a manual count.

---

## Scope, decided before this slice started

AGENTS.md's own build order names slice 4 as "extraction with confirmation, offline draft queue, push, the health console, reports." Cut, all reasoned through in the approved plan rather than assumed:

- **The confirm screen's vendor fuzzy-match badge** ("✓ Matched an existing vendor," shown in the brief's own mockup). Requesters have no read access to the vendor table at all, by deliberate slice-3 design — building this would mean either reopening that boundary or adding a narrow match-only RPC for a cosmetic badge. The vendor field stays free text; real vendor matching still happens at account time, unchanged.
- **phash wired into duplicate detection.** Computed and stored this slice (image uploads only — PDFs are skipped, an accepted limitation), but not yet load-bearing in `app_duplicate_check_candidates` — that's a real, separate scope (a new match kind, a SQL change) for later.
- **A job queue** (pg-boss/Inngest, the concept doc's own Layer 07 suggestion). AGENTS.md's own instruction supersedes it for this build: no queue until per-item retry-with-backoff is actually needed. Extraction runs synchronously inside the capture→confirm transition instead.
- **"Drafts stuck offline" on the health console**, and **"jobs and latency."** The first needs client-truth-reporting infra (a heartbeat/beacon) disproportionate for one tile; the second needs a queue or an APM neither of which exists.
- **Two of the brief's 8 "ship from day one" reports**: accounting reconciliation vs. Tally (no Tally integration exists anywhere in this codebase to reconcile against) and advances outstanding (depends on the settlement-ledger/advances feature slice 3 explicitly scoped out in full). The remaining 6 are buildable from tables that already exist.
- **A PDF report-export pipeline.** CSV only this slice — a real, separate technical concern.

**A planning-integrity gap surfaced, not silently absorbed**: AGENTS.md lists "vouchers export one-way to Tally with a nightly reconciliation report" under *Decided*, not *Deferred* — but no phase across all four slices builds it, and this slice's own AGENTS.md description doesn't mention Tally either. Cutting the reconciliation *report* here is correct (nothing exists to reconcile against), but the export itself still needs a decision: a named future slice, or moved from Decided to Deferred in AGENTS.md.

---

## Design decisions

**Extraction blocks the capture→confirm transition, client-side, with a visible timeout — it does not run as a detached background job.** A freshly captured request never sits in `raised` (that stage is reserved for return-for-correction); it lands directly in `awaiting_approval`. So "extraction never blocks submit" (AGENTS.md) means the capture→confirm transition specifically, not some already-existing row: the client awaits extraction synchronously, with a ~25s timeout, before the (same, single) form shows its fields — pre-filled with confidence badges on success, blank and fully editable on failure or timeout. There is no separate "confirmation screen" component: the confirm step and the manual-entry/offline-fallback step are the same screen, because an offline-captured draft can never have anything to confirm and a failed extraction must degrade to exactly that same state.

**Extraction is keyed by the uploaded file, not the request, because the request doesn't exist yet.** `extraction_attempt` (`storageKey`, `attemptedBy`, `requestId` nullable, `status`, `model`, `escalated`, `error`) is written the moment extraction runs — success or failure, always. `submitRequest`'s own transaction backfills `requestId` onto whichever attempt actually gets submitted, **including a failed one** (this is deliberate: it's what distinguishes "completed by hand" from "abandoned" for the health console's own abandonment metric — an attempt whose `requestId` never gets backfilled at all is the one that was actually abandoned). `extraction` holds one row per field (`value`, `confidence`, `acceptedValue`, `correctedBy`), diffed against the final submitted values inside that same transaction — never re-querying the model. `request.raised`'s own event gets a compact `extraction` summary (`model`, `escalated`, `fieldsCorrected`) in its `after` payload; the full per-field detail lives in the `extraction` table itself — the same "summary in the event, full detail in its own table" split `duplicateCheck`/`duplicateVerdict` already established.

**Decisive fields, and their starting confidence floors**: amount (0.85), vendor (0.80), invoiceNo (0.80) — the same three fields duplicate control already treats as the load-bearing signal. Only these trigger escalation to `claude-sonnet-5`; currency is always "INR" and never asked of the model at all; invoiceDate and the new `request.gstinOnBill` get a confidence badge but never gate escalation. These are starting values, not fixed ones — the escalation-rate metric this slice makes measurable is the actual feedback loop for tuning them.

**phash reuses the same bytes already fetched for the vision call** — a difference-hash (`sharp`, no separate phash package), image/jpeg only, written to `request_file.phash` (reserved since phase 1) at submit time, on the first page only (extraction only ever reads the first attachment — a multi-page bill's headline fields read off page one).

**Offline queueing is entirely client-side.** IndexedDB (`idb`) holds queued drafts — downscaled bytes, computed sha256, form fields — written when a PUT or submit fails or the browser is offline. Flushing mints a **fresh** upload slot (presigned URLs expire in 10 minutes; a queued draft can't carry an old one) and goes through the existing, unchanged upload/submit path. Foreground-retry-on-open is the universal baseline (true background sync has no iOS equivalent); Android additionally registers Background Sync as a progressive enhancement. The Serwist service worker precaches content-hashed static assets only and never page HTML (AGENTS.md rule 2) — a shared plant device is exactly the scenario this rule exists for.

**Push mirrors email's exact trigger set, at the shared recipient-resolution helpers, not per wrapper function.** `sendPush` mirrors `sendEmail`'s shape precisely (never throws, suppresses cleanly when VAPID keys are unset, auto-deletes a subscription on 404/410). No dedicated notification-preferences screen — one "Enable notifications" opt-in, nothing more, matching what the brief itself shows.

**The health console is developer-only.** `developer`/`super_admin` already have full, unscoped SELECT on every table this needs (verified directly against the RLS migrations, not assumed) — only this slice's own new tables need fresh policies. A feature-flags table lets phase 13's and phase 15's own code be toggled off, retrofitted in, not built ahead of time.

**Reports redact to counts for the developer role from day one** — one of AGENTS.md's own named, non-negotiable rules ("developer sees the machine, not the money"), not a nice-to-have deferred to later. `report_run` logs every run, matching "exports are logged like everything else."

---

## Phase breakdown

Continuing the phase numbering across slices — phase 13 onward. Each phase is its own branch + PR, ending in the standard verification sequence. 13 and 14 can proceed in parallel (both touch `CaptureForm.tsx` — coordinate landing order). 15 hard-depends on 14 (needs the service worker to exist). 16 depends on 13 and 15 having real data flowing, and retroactively touches both their call sites for the feature-flag guard. 17 is independent of the rest — it reads only tables that have existed since slices 1–3.

### Phase 13 — Extraction with confirmation ✅ shipped

- Migrations: `extraction_attempt` (id, storageKey, attemptedBy, requestId [nullable], status, model, escalated, error, createdAt), `extraction` (id, attemptId, field, value, confidence, acceptedValue, correctedBy, createdAt), `request.gstinOnBill` (nullable text). RLS: both new tables visible to the attempting requester plus the standing `super_admin`/`developer` global-read branch every table already uses; INSERT/UPDATE restricted to the attempt's own owner.
- `src/extraction/{confidenceFloors,schema,client,extractCore,dhash,env}.ts` — `extractCore.ts`'s `runExtraction` is the one place an attempt gets written (success or failure, always) and the one place tier-1→tier-2 escalation is decided; `attachExtractionToRequest` is the one place `acceptedValue`/`correctedBy` get filled in, called from inside `submitRequest`'s own transaction. `client.ts` forces structured output via a tool call (`submit_extraction`) rather than parsing free-form JSON out of the model's prose — the standard, reliable way to get Claude to answer in a fixed shape.
- `src/storage/r2.ts` gained `getObjectBytes` — the one place this codebase actually downloads a bill's bytes rather than presigning access to them.
- `src/events/render.ts`'s `request.raised` case gained the extraction summary (`· extraction escalated to sonnet`, `· N fields corrected`) — no new event type.
- `CaptureForm.tsx` evolved in place (not a new component): confidence badges per field, a GSTIN field, the "Reading the bill…" state with its own timeout, a visible degrade-to-blank message on failure, and a non-blocking "Seen this before?" note for the `warned_open` duplicate verdict (previously silently recorded, never shown — closed as part of touching this screen anyway).
- New dependencies: `@anthropic-ai/sdk`, `sharp`.

**What the plan didn't anticipate, found during implementation:**
1. **Multiple events in one transaction would have shared an identical timestamp.** Postgres's `now()` returns the same value for every call within one transaction — if `request.raised`/`extraction.attempted`/`extraction.escalated`/`extraction.field_corrected` had been written as separate event rows (as the original approved plan described), their relative order in the trail (`ORDER BY at ASC`) would have been undefined, since nothing in this codebase had ever inserted more than one event per transaction before. Resolved by folding a compact summary into `request.raised`'s own `after` payload instead — the same pattern `duplicateCheck`/`duplicateVerdict` already established, and a genuine simplification over what was planned, not just a workaround.
2. **`ANTHROPIC_API_KEY` isn't configured in this environment yet.** Verified live: the whole "unconfigured integration fails visibly" path works exactly as designed — a real capture, a real (empty-input) upload, a recorded `failed` extraction_attempt with a clear error, blank editable fields with a visible message, a normal submission on top. **Not yet verified**: an actual tier-1/tier-2 model call, real confidence scores against a real bill, or a real escalation. That needs the key added first — flagged directly rather than claimed as done.
3. **Backfilling `requestId` onto a *failed* attempt is correct, not a bug** — worth calling out because it isn't obvious on first read. It's the entire mechanism behind "completed by hand" vs. "abandoned" for phase 16's abandonment-rate metric.

### Phase 14 — Offline draft queue
No schema. `src/capture/imagePrep.ts` (downscale/sha256, extracted from `CaptureForm.tsx` rather than duplicated), `src/capture/draftQueue.ts` (`idb`), `public/manifest.json` or `src/app/manifest.ts`, `src/sw.ts` + `withSerwist` in `next.config.ts`. Done means: offline capture queues and shows the banner; reconnecting flushes through the real path with a freshly-minted upload slot; a killed-and-reopened tab proves persistence; two different logged-in sessions on one browser profile never leak a cached page to each other.

### Phase 15 — Push
Migrations: `push_subscription`, `push_send_log`. `src/notifications/push.ts` + `pushEnv.ts`; `src/notifications/recipients.ts`'s four shared helpers gain push fan-out (not the 11 wrapper functions individually — `tests/notifications.test.ts` will need updating, not just extending). `src/sw.ts` gains a `push` listener. New dependency: `web-push`. Done means: a real VAPID-signed push arrives on a real stage transition, logged; a stale endpoint's 404/410 deletes the subscription and logs `gone`.

### Phase 16 — Health console
Migration: `feature_flag`, plus a retrofitted one-line guard into phase 13's and 15's call sites (named explicitly in this phase's own PR, not silent scope creep). `src/health/loadHealthMetrics.ts` (requests raised, extraction success/escalation %, abandonment rate, median approval time, push delivery %, storage), `src/health/HealthConsole.tsx` + route, an extraction-failures queue with a diagnostic-only Retry, a feature-flags panel. Cut outright: jobs/latency, drafts-stuck-offline. Done means: every tile hand-verified against a deliberately seeded mix of succeeded/escalated/failed/abandoned attempts; an `accountant`/`payer` actor gets `UnauthorizedGrantError`, never an empty page.

### Phase 17 — Reports
Migration: `report_run`. `src/reports/{ageingReport,cycleTimeReport,spendReport,controlExceptionsReport,rejectionsHoldsReport,approverLoadReport}.ts` (the ageing report reuses `computeFlags.ts`'s own threshold/loader pattern directly), `src/reports/redact.ts`, `src/reports/csv.ts`, `src/app/api/cron/[job]/route.ts` + `vercel.json` (guarded by `CRON_SECRET`). Done means: each report hand-verified against real seeded data; a `developer`-run report shows redacted counts, `super_admin` shows real amounts, same data; the cron route rejects a request missing its secret.

---

## Done means, for the whole slice

- A real bill, photographed on a real phone, comes back with fields a person only has to glance at — not retype — and a low-confidence field is the only thing that demands a tap.
- A capture with no signal at all still queues and still sends, without the requester doing anything differently.
- A stage handover reaches an installed phone before the email does, most of the time, and the gap between "most" and "always" is a number on a screen, not a guess.
- The machine's own health — extraction accuracy, escalation rate, abandonment, push delivery, storage — is visible to whoever can act on it, with zero amounts, zero vendor names, zero bill files.
- The six day-one reports are one click from a real number, and every number is the same whether it's read off a screen or exported to CSV.

---

## Decisions already made — do not reopen

No job queue this slice. Extraction blocks the capture→confirm transition client-side. The confirm screen and the manual/offline-entry screen are one component. Vendor fuzzy-match badge cut. phash stored, not yet load-bearing. Offline queueing is 100% client-side. Push fans out at the four shared recipient-resolution helpers. Health console is developer-only; jobs/latency and drafts-stuck-offline cut outright. Reports: 6 of 8 day-one reports, CSV only, redaction built in from day one, not deferred.

Confirm before slice 4 fully ships: the Tally-export planning gap (see Scope, above) needs its own decision — a named future slice, or an AGENTS.md correction — it doesn't resolve itself by this slice shipping.

## Where to look things up

| Question | Answer lives in |
|---|---|
| What does the confirm screen actually show, field by field? | `docs/concept-v2.html` §02, and `CaptureForm.tsx` |
| What triggers escalation, and by how much? | This document's "Design decisions," and `src/extraction/confidenceFloors.ts` |
| Why does a failed attempt still get a `requestId`? | This document's phase-13 findings, and `captureCore.ts`'s own comment on `extraction?:` |
| What's cut from the health console, and why? | This document's "Scope" section |
| Which reports ship now vs. later? | §13, and this document's "Scope" section |
| Why these specific RLS/service-worker/queue choices? | This document's "Design decisions" section |
