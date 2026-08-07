# JobProfitAI

Weekly AI-generated job-cost & profitability digest for contractors, built on top of QuickBooks Online.

## What's built (Week 1 scaffold)

- Next.js 14 (App Router, TypeScript, Tailwind)
- Prisma data model: users, QuickBooks connections, jobs, cost entries, invoices, weekly digests, subscriptions (`prisma/schema.prisma`)
- Email/password auth with signed session cookies (`src/lib/auth.ts`)
- QuickBooks OAuth2 flow: connect → callback → token storage, encrypted at rest (`src/lib/quickbooks.ts`, `src/app/api/quickbooks/*`)
- Data sync from QBO into local tables (`src/app/api/quickbooks/sync/route.ts`)
- Job-profitability engine (`src/lib/profitability.ts`)
- AI digest generator via the Claude API, grounded strictly in computed metrics (`src/lib/digest.ts`)
- Marketing home page + How It Works page, login/signup, and a minimal dashboard

## Important: this was hand-written, not yet installed or run

This code was written in a sandboxed environment without access to the npm
registry, so `npm install` has **not** been run and the app has **not** been
built or tested yet. Before you rely on it, run it locally or push it to
Vercel (see below) and fix whatever the first `npm install` / `npm run build`
surfaces — treat this as a strong first draft, not verified-working code.

## Running it locally

1. Install Node.js 20+ if you don't have it.
2. `npm install`
3. Copy `.env.example` to `.env` and fill in:
   - `DATABASE_URL` — a Postgres connection string (Supabase or Neon both have free tiers; easiest is to create a project there and paste the connection string)
   - `AUTH_SECRET` and `TOKEN_ENCRYPTION_KEY` — generate each with `openssl rand -base64 32`
   - `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` — from your Intuit Developer app (Sandbox keys first)
   - `ANTHROPIC_API_KEY` — from console.anthropic.com
4. `npm run db:push` — creates the tables in your database from `prisma/schema.prisma`
5. `npm run dev` — starts the app at http://localhost:3000

## Deploying (recommended path, since this sandbox can't build it directly)

1. Push this folder to a new GitHub repository.
2. Import that repo into Vercel (vercel.com) — Vercel runs its own `npm install`
   and build on its servers, which sidesteps this sandbox's network
   restrictions entirely.
3. Add the same environment variables from `.env` in the Vercel project settings.
4. Set `APP_URL` and `QBO_REDIRECT_URI` to your real Vercel domain once deployed.

## What's intentionally not done yet (later in Week 1 / Week 2)

- Stripe billing (Week 3 per the launch plan)
- Weekly digest email delivery via Resend + SPF/DKIM/DMARC (Week 2)
- Pricing / Privacy Policy / Terms of Service pages (Week 2 — Privacy/Terms need real legal review, not placeholder text)
- Automated weekly sync (cron) — sync and digest generation are manually triggered from the dashboard for now, so you can test against a real Sandbox company first
- Classes-based job costing (currently only Projects/sub-customer mode is implemented in the sync route — flagged as a TODO in `src/app/api/quickbooks/sync/route.ts`)
