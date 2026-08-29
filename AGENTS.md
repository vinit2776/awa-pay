<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# awa-pay

A payment-request system for an invoice that arrives without a purchase order behind it. Somebody photographs a bill, and it crosses four desks — approver, accounts, payer — before it becomes a UTR number on a record. The full brief, with screens, is `docs/concept-v2.html`; open it in a browser and read it before building anything substantial.

**This is a fresh project.** A previous procurement platform (`AWA-Local`, repo `vinit2776/awa`) exists on this machine and is deliberately parked. Do not read it, copy from it, or carry its schema, vocabulary or phase structure across. If something here looks like it needs solving and you suspect that repo solved it, solve it here from the brief instead. The one exception is the "Rules that are not up for rediscovery" section below, which already carries forward everything worth carrying.

## Vocabulary — use these words, and only these

A shared vocabulary is the thing most likely to rot first, so it is fixed here rather than left to drift.

| Use | Never |
|---|---|
| **request** — one bill moving through the system | requisition, ticket, claim |
| **department** — who raised it, and what approvers are scoped to | cost centre, team, division |
| **company** — the legal entity a bill books into | entity, org, tenant |
| **head** — head of account it books against | GL code, category, ledger |
| **voucher** — the accountant's voucher number | journal, entry |
| **stage** — where a request is right now | status, state, step |
| **query** — a question that freezes a request in place | clarification, hold |
| **return / hold / reject** — the three ways to decline | reject-with-reason, bounce |
| **settlement ledger** — what is owed, paid, and still due on a request | schedule, plan |

## The lifecycle

Five stages. A request is always in exactly one, and the stage names who owns it right now. A queue is *the requests in my stage, in my departments*.

1. **Raised** — bill captured on mobile, fields extracted and confirmed, department attached.
2. **Awaiting approval** — an approver qualifies it and sets the payment cycle: unspecified, immediate, or a named date.
3. **With accounts** — head, voucher, company. Vendor matched or created.
4. **To pay** — payer verifies vendor bank against the bill, pays outside the system, records the reference.
5. **Paid** — closed, but the comment thread stays open forever.

Not every request reaches stage 5. An approver has three other answers, and they are not the same event:

- **Return for correction** → back to the requester, same reference, resubmits as revision 2.
- **Hold — vendor issue** → parked with a review date, excluded from ageing, escalated past 60 days.
- **Reject** → closed unpaid, terminal, with a written reason.

A **query** is none of those: it freezes the request where it stands and leaves ownership unchanged.

## Roles and scope

Access is three independent answers: what can this person do, for which departments, and — for the two desks that touch the books — for which companies.

| Role | Department scope | Company scope |
|---|---|---|
| Requester | Named departments only, never global | n/a |
| Approver | Global or named departments | n/a |
| Accountant | Global or named departments | Global or named companies |
| Payer | Global or named departments | Global or named companies |
| Super admin | Always global | n/a — configures, never approves or pays |
| Developer | Always global | n/a — sees the machine, not the money |

The whole permission model is one `role_grant` table. Three roles for one person is three rows.

Company scope behaves differently at each desk: for the payer it filters the queue, because the company is already decided. For the accountant it cannot, because the company is what they are about to choose — it constrains the dropdown instead.

## Rules that are not up for rediscovery

Each of these cost a real bug somewhere. They are not suggestions.

1. **The role the app queries as must not own the tables.** Postgres exempts table owners from row-level security, so an app connecting as the owner has RLS silently switched off and no error to tell you. Two connection strings, two roles, and a test that proves an unscoped query returns nothing.
2. **The service worker must never cache page HTML.** Shared plant and office devices mean the next person to open the app is someone else. Cache immutable static assets only; fall back to a generic offline page, never to a copy of where somebody else was.
3. **An audit entry commits in the same transaction as the thing it describes.** Otherwise there is a window where the action exists and its record does not, and that is exactly where an investigation lands.
4. **A notification must never break what triggered it.** Bound sends with a timeout, never let them throw, and suppress them under test so a stray key cannot fire real mail at fixture addresses.
5. **An unconfigured integration fails visibly at the edge, not quietly in the middle.** Every optional integration reports its status somewhere a human looks. Graceful degradation without a health surface is how a feature sits dead for months.
6. **Money is integer minor units.** Paise, never floats, with the currency alongside. Indian digit grouping is a display concern, decided once in one formatter.
7. **Duplicate control lives in the database.** A partial unique index on `(vendor_key, invoice_key, fy) WHERE stage = 'paid'`, plus a unique index on the payment reference. A UI lookup cannot stop two simultaneous submits — both queries return nothing before either writes.
8. **Every read is scoped in the data layer, not the UI.** Hiding a row in React is not access control.

## Build order

Four slices, each usable on its own. Do not reorder them.

1. **The spine** — auth, departments, role grants, raise from mobile with a file and a note, approve, account, pay, the trail. No extraction, no vendor master, no flags. One department, real bills.
2. **The conversation** — comments, queries with their hold behaviour, nudges, email notifications, the full request record.
3. **The master** — vendor records with KYC and versioned bank details, payer verification, payment history, computed flags. All departments.
4. **The speed** — extraction with confirmation, offline draft queue, push, the health console, reports.

Extraction is deliberately last despite being the most impressive part. If the flow only works when the model reads the bill correctly, the flow does not work.

## Stack

Next.js App Router, TypeScript, Tailwind. Postgres via Supabase in `ap-south-1` with Drizzle, RLS on a restricted runtime role. Cloudflare R2 for bills, presigned, versioned, object-locked, eight-year retention. Auth is hand-rolled in the application, not a hosted IdP — argon2id-hashed passwords, opaque DB-backed sessions (never JWT, so the payer role can be revoked on demand), TOTP MFA required on any account holding the payer role. Resend for email, Web Push via VAPID. Vercel, region `bom1`.

Extraction is two-tier: `claude-haiku-4-5` on every bill, escalating to `claude-sonnet-5` when any decisive field falls below its confidence floor or the JSON fails to validate. Escalate on confidence, not only on failure — a confidently wrong amount is worse than a missing one. Store both the model's answer and the human's correction, so accuracy is measurable rather than assumed. The escalation rate is a metric, not a detail.

No job queue yet. Scheduled work runs on Vercel Cron; a real queue earns its place when extraction needs per-item retry with backoff.

## Decided, and deferred

Settled: vendor capture sits with accounts, not the payer. One request books to exactly one company, no splitting. A query freezes rather than bounces. A payment is immutable once recorded, though a request accepts more than one until its balance is zero. Financial year is part of the duplicate key. A rejected bill may be resubmitted — escalated, routed back to the approver who declined it, never silent. Self-approval is permitted, recorded, and reported, never blocked. TDS is calculated and editable. Vouchers export one-way to Tally with a nightly reconciliation report.

Deferred on purpose: amount thresholds for a second approval. Purchase orders, goods receipts and three-way matching — **this is the largest control this design does not have**, and the approver's judgement is currently the only check that what was billed is what was ordered. Cover for a department whose only approver is away.

Open: retention money on works contracts, and who chases a refund when a final invoice lands below the advance paid.

## Shipping

Branch and PR into `main`, never a direct push. Branches are `<type>/<desc>` with types `feat`, `fix`, `chore`, `refactor`, `docs`. CI must pass before merge. Delete the branch after.

Decide branch protection once, early — on the free plan it is unavailable on a private repo, so either the repo goes public, the plan changes, or this section is a norm rather than a rule and should say so honestly.

Secrets go in Vercel or `.env.local`, never in the repo and never pasted into chat. `.env.example` documents names without values.

## Two things about this Next version

- **`npm run typecheck` only passes after `npm run build`.** Next generates the typed-route helpers (`LayoutProps`, `PageProps`) into `.next/types` during the build, so a bare `tsc --noEmit` on a clean checkout fails with `Cannot find name 'LayoutProps'`. CI orders it build-then-typecheck for this reason; keep that order.
- **The `nextjs-agent-rules` block at the top of this file is written by `next dev`.** Deleting it from a diff only re-creates the uncommitted change. Commit it along with your work.
