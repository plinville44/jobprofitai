# JobProfitAI

**Profit Intelligence for QuickBooks.** Job-level profitability, margin leak detection and
actionable recommendations for contractors running on QuickBooks Online.

Next.js 14 (App Router) · TypeScript · Tailwind · Prisma · Neon Postgres · Stripe ·
Resend · Anthropic Claude · deployed on Vercel.

---

## What's here

### Product
- **QuickBooks Online integration**. OAuth 2.0 via Intuit's discovery document, tokens
  and realm IDs encrypted at rest (AES-256-GCM), incremental sync, disconnect with token
  revocation (`src/lib/quickbooks.ts`, `src/lib/quickbooksSync.ts`)
- **Profitability engine**. Revenue, cost, gross profit and margin per job; needs-attention
  rules; forecast at completion; profit leakage; cross-job opportunities; data health
  (`src/lib/profitability.ts`, pure and unit-tested)
- **Profit intelligence**. Claude writes the explanation around numbers the application
  computes; every figure is replaced with the deterministic value before storage
  (`src/lib/intelligence.ts`, `src/lib/digest.ts`)
- **Weekly Profit Brief**, per-customer day/hour/timezone, sent by an hourly cron

### Commercial systems
- **Plan catalog** (`src/lib/plans.ts`), the single source of truth for pricing, limits and
  marketing copy, read by both the app and the marketing site so they cannot drift apart
- **Entitlements** (`src/lib/entitlements.ts`). Server-side access control across trial,
  active, past-due, canceled and expired states, plus plan limits
- **Trial system** (`src/lib/trial.ts`). Card-free 14-day trial, activation tracking, and a
  one-time +14 day extension earned by a feedback survey (never a testimonial)
- **Stripe billing** (`src/lib/stripe/`). Hosted Checkout and Billing Portal, signature-verified
  and idempotent webhooks, no card data on our infrastructure
- **Customer referrals** (`src/lib/referrals.ts`), one free month of the referrer's plan,
  earned after 30 days of sustained payment, issued as a stacking Stripe balance credit
- **Partner program** (`src/lib/partners.ts`), 20/25/30% recurring commission for accounting
  firms on each client's first 12 paid months, with a full commission ledger
- **Lifecycle email** (`src/lib/email/`). Branded templates and a send-once ledger enforced
  by a database unique constraint, so an hourly cron can retry freely

### Marketing site
Public pages under `src/app/(marketing)/`: home, pricing, how it works, security, partners,
contact, privacy, terms, plus sitemap, robots and social metadata.

---

## Running locally

```bash
npm install
cp .env.example .env      # then fill it in. See the comments in that file
npx prisma generate
npx prisma db push        # creates tables from prisma/schema.prisma
npm run dev               # http://localhost:3000
```

Minimum to get the app running: `DATABASE_URL`, `AUTH_SECRET`, `TOKEN_ENCRYPTION_KEY`.
Add `QBO_*` for QuickBooks, `ANTHROPIC_API_KEY` for insights, `STRIPE_*` for billing and
`RESEND_API_KEY` for email. Anything missing degrades gracefully with a clear message
rather than crashing.

```bash
npm run test              # vitest
npm run build             # production build + type check
```

---

## Architecture notes worth knowing

**Entitlements are enforced on the server, always.** Every gated page and API route calls
`getEntitlements()` / `requireFeature()`. Hiding a button in the browser is not a control,
and gated pages check before loading any financial data, a lapsed account never has its
numbers computed and sent to the browser.

**Idempotency is enforced by database constraints, not by code paths.** Retries are the
normal case (Stripe redelivers, cron re-runs), so correctness rests on unique indexes that
a race cannot slip past:

| Guarantee | Enforced by |
|---|---|
| A webhook event is processed once | `StripeEvent.id` primary key |
| A lifecycle email is sent once | `EmailEvent.dedupeKey` |
| A trial is extended once | `TrialFeedback.userId` |
| An account is referred once | `Referral.referredUserId` |
| A referral earns one reward | `ReferralReward.referralId` |
| An invoice commissions once | `PartnerCommission.stripeInvoiceId` |

**Referral partners get no access to customer data.** Partner status grants a referral code
and a commission ledger. Nothing more. Contractor financial data requires that contractor's
explicit invitation, which is an unrelated system.

**AI never produces a number.** Dollar amounts, percentages, confidence levels and the jobs
behind each finding are all computed by application code and re-applied after the model
responds. The model writes prose only.

---

## Deploying

Push to GitHub; Vercel builds from `main`. Before the first production release, work through
[`PRODUCTION_CUTOVER.md`](./PRODUCTION_CUTOVER.md). It lists every external action needed in
Vercel, Stripe, Intuit, Resend and Neon, and the smoke test to run afterwards.

---

QuickBooks is a trademark of Intuit Inc. JobProfitAI is an independent product and is not
affiliated with or endorsed by Intuit. A product of PWL Solutions LLC.
