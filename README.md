# awa-pay

A payment-request system for bills that arrive without a purchase order behind them.

Somebody photographs an invoice on their phone. It crosses four desks — approver, accounts, payer — and ends as a UTR number on a permanent record. Along the way it cannot be paid twice, cannot be declined silently, and cannot be edited without leaving a trace.

- **The brief** — [docs/concept-v2.html](docs/concept-v2.html). Eighteen sections: the lifecycle, mobile and desktop screens, duplicate control, advances and part-payments, reports, the audit trail, the data model and the infrastructure plan. Open it in a browser. Read it before building anything substantial.
- **Working rules** — [AGENTS.md](AGENTS.md). Vocabulary, role scope, the rules that are not up for rediscovery, and the build order.

## Status

Scaffold only. Nothing in slice 1 is built yet.

## Build order

1. **The spine** — auth, departments, role grants, raise from mobile, approve, account, pay, the trail. One department, real bills, no extraction.
2. **The conversation** — comments, queries, nudges, notifications, the full request record.
3. **The master** — vendor records with KYC and versioned bank details, payer verification, computed flags.
4. **The speed** — extraction, offline drafts, push, the health console, reports.

## Stack

Next.js App Router with TypeScript and Tailwind. Postgres on Supabase (`ap-south-1`) with Drizzle and row-level security on a restricted runtime role. Cloudflare R2 for bill storage. WorkOS AuthKit. Resend and Web Push for notifications. Vercel, region `bom1`. Extraction runs `claude-haiku-4-5` first and escalates to `claude-sonnet-5` on low confidence.

## Local setup

```bash
npm install
cp .env.example .env.local   # fill in from Vercel; never commit values
npm run dev
```

Nothing but the dev server works yet — no database, no auth, no storage. Those arrive with slice 1.

## Relationship to the earlier platform

A previous procurement platform exists in `vinit2776/awa` and is **parked** — not live, no users, no data. This project does not extend it, share code with it, or migrate from it. It is a deliberate fresh start; the reasoning is in section 17 of the brief.
