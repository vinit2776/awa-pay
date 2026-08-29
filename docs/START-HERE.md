# Start here — handoff for slice 1

You are picking up a project that has a complete brief and no application code. This document is the state of play and the order of work. Read it, then read `AGENTS.md`, then open `docs/concept-v2.html` in a browser.

Nothing here needs to be recovered from a conversation. If something is not written down in this repository, it was not decided.

---

## Where things stand

| | |
|---|---|
| **Repo** | `vinit2776/awa-pay`, private, `main` |
| **Commits** | Scaffold only — three commits, no application code |
| **Stack** | Next 16.3.3, React 19.2.8, Tailwind 4, TypeScript, App Router, `src/` |
| **CI** | lint → build → typecheck. Green on push and pull request |
| **Provisioned** | Nothing. No database, no storage, no auth, no deployment |
| **Branch protection** | Not enabled — unavailable on a private free-plan repo |

The parked procurement platform lives in `vinit2776/awa`. **Do not read it.** If you hit a problem you suspect it solved, solve it here from the brief. Everything worth carrying across is already in `AGENTS.md` under "Rules that are not up for rediscovery".

---

## Slice 1, in one sentence

One real bill, photographed on a phone by a requester, crosses all five stages — approver, accounts, payer — and every step of it is visible in the trail.

One department. Real bills. No extraction, no vendor master, no comments, no notifications, no reports, no offline. Those are slices 2, 3 and 4 and they are listed in `AGENTS.md` in the order they should arrive.

---

## Phase 0 — provisioning, before any code

This is the only genuinely blocking work, and most of it is account creation that has to happen in a browser rather than here.

**Slice 1 needs three services, not eight.** Notifications arrive in slice 2 and extraction in slice 4, so Resend and the Anthropic key are not blockers — leave `RESEND_API_KEY`, `EMAIL_FROM` and `ANTHROPIC_API_KEY` unset for now. There is no fourth, WorkOS-shaped service: auth is hand-rolled in the app, so it needs code in phase 2, not an account in phase 0.

1. **Supabase project** named `awa-pay`, region `ap-south-1`. Not a schema inside an existing project — its own project, so nothing is shared with the parked app.
2. **Two Postgres roles, two connection strings.** This is rule 1 in `AGENTS.md` and it is the single most important step in phase 0. Create a restricted runtime role; `DATABASE_URL` uses it and RLS applies to it in full. `DATABASE_URL_MIGRATIONS` uses the table owner, is used only by migration tooling, and is never imported by application code. Getting this wrong means RLS is silently off with no error to tell you.
3. **Cloudflare R2 bucket** for bills, with a token scoped to that bucket alone. Turn on versioning and object lock at creation, and set retention to eight years — retrofitting retention onto existing objects is harder than setting it now.
4. **Vercel project** named `awa-pay` — matching the repo, not a fourth name — region `bom1`, linked to this repo. Set every variable there, across Production, Preview and Development. Never commit a value; never paste one into chat.
5. **An error tracker.** Rule 5 says an unconfigured integration must fail visibly. That needs somewhere for failures to land, from day one rather than month thirty.
6. **Two secrets for the auth system**, generated with `openssl rand -base64 32` each: `SESSION_SECRET` (signs the session cookie's integrity check — sessions themselves live in Postgres, opaque and revocable, never a JWT) and `MFA_ENCRYPTION_KEY` (encrypts stored TOTP seeds at rest, separate from `BANK_ACCOUNT_ENCRYPTION_KEY` so rotating one never touches the other).

`.env.example` documents every name. Copy it to `.env.local` and fill in from Vercel.

---

## Phase 1 — the data spine

Nothing renders yet. This phase is the part that is hard to change later.

- Drizzle and a Postgres client with the two connection strings kept genuinely separate — separate modules, so importing the wrong one is visible in a diff.
- A scoping helper that resolves the caller's role grants and sets the scope for the transaction. **Do not call it `withTenant`.** There are no tenants here; there are departments and companies. Name it for what it does.
- Migrations for: `company`, `department`, `user`, `role_grant`, `request`, `request_file`, `event`.
- RLS policies on every scoped table, enforced against the runtime role.
- **The gate:** a test proving an unscoped query as the runtime role returns nothing even when matching rows exist, and that a scoped query returns exactly the right rows and none of the wrong ones. Do not proceed to phase 2 until this is green. It is the test the whole access model rests on.

Money is integer minor units — paise, with the currency alongside. Decide the formatter once and put it somewhere obvious before the first amount is rendered.

The `event` table is append-only. Revoke `UPDATE` and `DELETE` from the runtime role on it in the same migration that creates it, so it is never briefly mutable.

---

## Phase 2 — auth

Hand-rolled, not a hosted IdP — deliberately, at this scale. No third-party account to provision, no redirect flow to debug, and one organisation means there is no tenant-to-organisation matching to do at sign-in either. Resist adding that indirection for a multi-tenancy that is explicitly aspirational.

- **Passwords:** argon2id (`@node-rs/argon2` — native binding, no hand-rolled crypto). Never bcrypt for new code; argon2id is the current OWASP-recommended default.
- **Sessions:** a `session` table — random 32-byte token, SHA-256 hashed before it touches the database so a DB leak doesn't hand over live sessions, `httpOnly` + `Secure` + `SameSite=Lax` cookie. No JWT: a session must be revocable the instant a payer account is compromised or offboarded, and a signed token that's already out in a browser can't be un-issued.
- **MFA:** TOTP (`otpauth` or equivalent RFC 6238 implementation), required at login for any account holding the payer role — this was WorkOS's job before and the requirement doesn't change with the provider. Store the seed encrypted with `MFA_ENCRYPTION_KEY`, generate a handful of single-use backup codes at enrollment, hashed the same way as passwords.
- **Provisioning stays admin-only.** Users are pre-provisioned, not self-serve: signing in with an email that has no matching user row fails loudly, because it means an admin step is missing. There is no "sign up" route.
- **Rate limit the login route.** A hand-rolled password check is a hand-rolled target for credential stuffing — this is the one piece a hosted IdP was quietly doing that now needs to be deliberate.

---

## Phase 3 — capture

- A mobile-first route: choose or photograph a file, add a note, pick a department, submit.
- Upload straight to R2 with a short-lived presigned URL. Downscale on the client before upload — a full-resolution phone photo over a plant's 3G is the difference between four seconds and four minutes.
- Checksum on arrival, stored on `request_file`.
- **No extraction in this slice.** Amount, invoice number and date are typed by hand. This is deliberate: if the flow only works when a model reads the bill correctly, the flow does not work.

Responsive web only. **Do not build a service worker, a manifest or an offline queue in slice 1** — installable PWA and offline drafts are slice 4. When you do get there, rule 2 applies: never cache page HTML.

---

## Phase 4 — the four desks

Build them in lifecycle order, because each one's output is the next one's input.

1. **Approver** — a shared queue filtered by department entitlement, oldest first. Approve with a payment cycle (unspecified, immediate, or a named date). The three declines — return, hold, reject — are three different outcomes and land the request in three different places; see section 04 of the brief.
2. **Accounts** — head, voucher number, company. Company scope constrains the dropdown here rather than filtering the queue, because the company is the thing being chosen.
3. **Payer** — record the payment and its reference. The reference is required. Money moves in the bank, not here.
4. **The trail** — rendered from the `event` table, on every request, visible to anyone in scope. Not an admin feature.

---

## Done means

- A bill photographed on a phone by one person is approved by a second, accounted by a third, paid by a fourth, and the trail shows all of it with who and when.
- The isolation test is green.
- A person scoped to one department cannot see another department's request by editing the URL — verified, not assumed.
- CI green, deployed to Vercel, and someone other than you has actually put a real bill through it.

That last one is the real gate. Everything before it is a claim.

---

## Traps, specific to this repo

- **`npm run typecheck` fails on a clean checkout.** Next generates `LayoutProps` and `PageProps` into `.next/types` during the build, so build first. CI is already ordered this way.
- **The `nextjs-agent-rules` block at the top of `AGENTS.md` is rewritten by `next dev`.** Commit it with your work rather than reverting it.
- **`.gitignore` swallows `.env*`.** There is a `!.env.example` negation; keep it if you touch that file.
- **Duplicate control is not fully possible in slice 1.** The hard block in the brief keys on vendor identity, which arrives with the vendor master in slice 3. Slice 1 stores an invoice number and a vendor name as text. Leave a `TODO` where the unique index will go — a system that can pay twice is survivable for one department of pilot users and is not survivable at rollout.

## Decisions already made — do not reopen

Vendor capture sits with accounts, not the payer. One request books to exactly one company, no splitting. A query freezes a request rather than bouncing it back. A payment is immutable once recorded, though a request accepts more than one until its balance is zero. Financial year is part of the duplicate key. A rejected bill may be resubmitted, escalated to the approver who declined it. Self-approval is permitted, recorded, reported, never blocked. TDS is calculated and editable. Vouchers export one-way to Tally.

Deferred on purpose: amount thresholds, purchase orders and three-way matching, cover for a department whose only approver is away. Purchase orders are the largest control this design does not have — the approver's judgement is currently the only check that what was billed is what was ordered. Know that; do not quietly fix it inside slice 1.

Still open: retention money on works contracts, and who chases a refund when a final invoice lands below an advance paid.

## Where to look things up

| Question | Answer lives in |
|---|---|
| What are the stages, and what do the screens look like? | `docs/concept-v2.html` sections 01–09 |
| Who can do what, and where? | `AGENTS.md`, and section 11 of the brief |
| What does the schema look like? | Section 15 of the brief |
| Why this stack, and what was deliberately dropped? | Sections 16 and 17 |
| What was decided and what is deferred? | Section 18 |
