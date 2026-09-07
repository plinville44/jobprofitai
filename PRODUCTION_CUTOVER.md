# JobProfitAI. Production Cutover

Everything in this document is an **external action you have to perform yourself**, in
Vercel, Stripe, Intuit, Resend or Neon. None of it can be done from the codebase, and
none of it has been done for you.

> **Nothing in this file has been configured.** The code is written and committed; the
> external accounts are untouched. Where this document says "create" or "set", assume it
> does not exist yet.

Work through the sections in order. Stripe and Resend need to exist before the app can
do anything useful with them.

**Never paste real secrets into this file, or into any file in the repository.**

---

## 0. Before you start. Build and test locally

The code in this repository was written in an environment with no access to the npm
registry, so it has **not been compiled, linted, or test-run**. Do this first, in your
project folder:

```bash
npm install
npx prisma generate
npm run test          # vitest. Trial, referral, partner, billing, email suites
npm run build         # next build. Type checking + production build
```

Fix anything these surface before deploying. A first build after a change this size
routinely turns up a type error or two; that's expected, not alarming.

To apply the new database tables locally:

```bash
npx prisma db push
```

---

## 1. Neon (database)

The schema change is **purely additive**. New tables and new columns that are either
nullable or have defaults. No existing column is dropped, renamed or retyped, so no
existing customer data is at risk.

New tables: `StripeEvent`, `EmailEvent`, `TrialFeedback`, `ReferralCode`, `Referral`,
`ReferralReward`, `Partner`, `PartnerCommission`, `ContactSubmission`.
New columns on `Subscription`: trial lifecycle, activation, Stripe identifiers, and
paid-lifecycle fields.
One relationship change: `Referral.referredUserId` is nullable with `ON DELETE SET NULL`,
so deleting a contractor's account no longer destroys a partner's commission history.

**Actions:**

1. **Take a backup / branch first.** In Neon, create a branch of the production database
   before migrating. This is the cheapest possible insurance and takes about ten seconds.
2. Confirm `DATABASE_URL` in Vercel points at the **production** Neon database (pooled
   connection string, `?sslmode=require`).
3. Apply the schema. Your Vercel Build Command currently runs `prisma db push`. Check it
   under **Vercel → Settings → General → Build Command**. If it reads:

   ```
   prisma generate && prisma db push --accept-data-loss --skip-generate && next build
   ```

   **remove `--accept-data-loss`**. It isn't needed for this migration, and leaving it in
   means a future schema mistake silently drops a column of real customer data instead of
   refusing. The safe version:

   ```
   prisma generate && prisma db push --skip-generate && next build
   ```

4. **Clean up the test accounts** (`test@`, `test2@`, `test3@`, `admin@jobprofitai.com`)
   before real customers arrive. They will otherwise appear in the new admin trial and
   referral views and distort every conversion number you look at.

---

## 2. Stripe

### 2a. Products and prices (LIVE mode)

Switch the Stripe dashboard to **live mode** (top-left toggle) before creating these, or
you will create test-mode objects and the live keys won't find them.

| Product | Price | Billing | Env var to receive the Price ID |
|---|---|---|---|
| Profit Intelligence | $149.00 USD | Recurring, monthly | `STRIPE_PRICE_PROFIT_INTELLIGENCE_MONTHLY` |
| Profit Intelligence Pro | $299.00 USD | Recurring, monthly | `STRIPE_PRICE_PROFIT_INTELLIGENCE_PRO_MONTHLY` |

Copy the **Price ID** (`price_...`), not the Product ID (`prod_...`).

Do **not** create a Starter, Basic or $79 product. The application has no such tier and
a test asserts it doesn't exist.

Repeat the same two products in **test mode** for staging, and keep those IDs separate.

### 2b. Webhook endpoint

Stripe Dashboard → **Developers → Webhooks → Add endpoint**.

- **Endpoint URL:** `https://jobprofitai.com/api/stripe/webhook`
  (use your real production domain. See §5 if the custom domain isn't connected yet)
- **Events to send**. Exactly these:
  - `checkout.session.completed`
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.paid`
  - `invoice.payment_failed`
  - `charge.refunded`
  - `charge.dispute.created`
- Copy the **Signing secret** (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`.

Create a **separate** endpoint in test mode with its own signing secret. The two secrets
are not interchangeable.

### 2c. Customer Portal

Stripe Dashboard → **Settings → Billing → Customer portal**. This must be configured once
per account or the "Manage Billing" button returns an error.

Turn on:

- Update payment method
- View invoice history
- **Cancel subscription**. Required for the "cancel anytime" claim on the pricing page to
  be true. If you don't enable this, remove that claim from the site.
- **Switch plan**, listing both Profit Intelligence and Profit Intelligence Pro, with
  proration enabled. Required for the in-app "change your plan" flow.

Set the return URL to `https://jobprofitai.com/dashboard/billing`.

### 2d. Verify without charging anyone

You can confirm live checkout works without taking a payment:

1. Sign in, go to **Billing**, click a plan.
2. You should land on a Stripe-hosted checkout page showing the correct plan and price.
3. **Stop there. Close the tab.** Do not enter card details.

That proves the secret key, price ID and session creation all line up. Do a full
end-to-end payment only in **test mode**, using Stripe's `4242 4242 4242 4242` test card.

---

## 3. Intuit / QuickBooks

Production keys were approved on 2026-08-12 but, as far as this repository knows, have
**not** been put into the live environment. The code is environment-aware and needs no
changes, only configuration.

**Actions:**

1. developer.intuit.com → your app → **Keys & credentials → Production**. Copy the
   Production Client ID and Client Secret (different from the Development pair).
2. In Vercel set, **scoped to the Production environment**:
   - `QBO_CLIENT_ID` = production client ID
   - `QBO_CLIENT_SECRET` = production client secret
   - `QBO_ENVIRONMENT` = `production`
   - `QBO_REDIRECT_URI` = `https://jobprofitai.com/api/quickbooks/callback`
3. In the Intuit app settings, under **Production → Redirect URIs**, add exactly:
   `https://jobprofitai.com/api/quickbooks/callback`
   It must match character for character, including `https` and no trailing slash.
4. Update the Production **App URLs** (host, launch, disconnect, EULA, privacy) to the
   real domain. They currently point at the `jobprofitai.vercel.app` placeholder.
5. Redeploy, then test the full connect → sync → disconnect cycle against a **real**
   QuickBooks company. Production keys will not accept a sandbox company.

> ⚠️ **The single most likely failure.** This project has already been bitten twice by
> environment variables that were saved without the **Production** checkbox ticked in
> Vercel, producing an "undefined didn't connect" error. Check the Production box on
> every variable, every time.

Leave your Development keys in the Preview/Development environments so sandbox testing
keeps working.

---

## 4. Resend

**Actions:**

1. resend.com → **Domains** → add and verify `jobprofitai.com` (add the SPF and DKIM
   records at your DNS provider). Until the domain shows **Verified**, every send is
   rejected, and because the Resend SDK reports that as a returned error rather than an
   exception, it will look like silence rather than a crash.
2. Create a production API key → `RESEND_API_KEY`.
3. Set:
   - `EMAIL_FROM` = `JobProfitAI <noreply@jobprofitai.com>` (must be on the verified domain)
   - `SUPPORT_EMAIL` = `support@jobprofitai.com`
   - `CONTACT_TO_EMAIL` = `support@jobprofitai.com`
   - `EMAIL_DEV_REDIRECT` = **empty in production** (setting it would silently redirect
     every customer email to one inbox)
4. **Confirm `support@jobprofitai.com` is a real, monitored mailbox.** It's on the
   marketing site, the security page, the footer, every transactional email's Reply-To,
   and every customer-facing error message. This is still listed as unresolved in the
   launch plan.
5. Consider adding a DMARC record once SPF and DKIM are verified.

---

## 5. Vercel

### 5a. Environment variables

Set every one of these in **Vercel → Settings → Environment Variables**. The
**Production** column is what production actually reads. This is the checkbox that has
already caused two outages on this project.

| Variable | Purpose | Where the value comes from | Prod | Preview | Dev |
|---|---|---|:--:|:--:|:--:|
| `DATABASE_URL` | Neon Postgres connection | Neon → Connection Details | ✅ | ✅ | ✅ |
| `APP_URL` | Absolute base URL for redirects, links, canonicals | Your domain | ✅ | ✅ | ✅ |
| `AUTH_SECRET` | Signs sessions + OAuth state | `openssl rand -base64 32` | ✅ | ✅ | ✅ |
| `TOKEN_ENCRYPTION_KEY` | Encrypts QBO tokens at rest | `openssl rand -base64 32` | ✅ | ✅ | ✅ |
| `ADMIN_EMAILS` | Admin area allowlist | Your own email(s) | ✅ | ✅ | ✅ |
| `QBO_CLIENT_ID` | QuickBooks OAuth | Intuit → Keys & credentials | ✅ | ✅ | ✅ |
| `QBO_CLIENT_SECRET` | QuickBooks OAuth | Intuit → Keys & credentials | ✅ | ✅ | ✅ |
| `QBO_ENVIRONMENT` | `production` / `sandbox` | Literal string | ✅ | ✅ | ✅ |
| `QBO_REDIRECT_URI` | OAuth callback | Must match Intuit exactly | ✅ | ✅ | ✅ |
| `ANTHROPIC_API_KEY` | Insights + digest narrative | console.anthropic.com | ✅ | ✅ | ✅ |
| `RESEND_API_KEY` | All transactional email | resend.com → API Keys | ✅ | ✅ | ✅ |
| `EMAIL_FROM` | Verified sending identity | Your verified Resend domain | ✅ | ✅ | ✅ |
| `SUPPORT_EMAIL` | Reply-To + support address | `support@jobprofitai.com` | ✅ | ✅ | ✅ |
| `CONTACT_TO_EMAIL` | Contact form destination | `support@jobprofitai.com` | ✅ | ✅ | ✅ |
| `EMAIL_DEV_REDIRECT` | Redirect all mail to one inbox | **Empty in production** | ❌ | ✅ | ✅ |
| `STRIPE_SECRET_KEY` | Stripe API | Stripe → API keys (live vs test) | ✅ | ✅ | ✅ |
| `STRIPE_WEBHOOK_SECRET` | Verifies webhook signatures | Stripe → Webhooks → endpoint | ✅ | ✅ | ✅ |
| `STRIPE_PRICE_PROFIT_INTELLIGENCE_MONTHLY` | $149 Price ID | Stripe → Products | ✅ | ✅ | ✅ |
| `STRIPE_PRICE_PROFIT_INTELLIGENCE_PRO_MONTHLY` | $299 Price ID | Stripe → Products | ✅ | ✅ | ✅ |
| `CRON_SECRET` | Authorizes scheduled jobs | `openssl rand -base64 32` | ✅ | ✅ |, |

Use **live** Stripe keys and **production** Intuit keys in Production only. Preview and
Development should use test/sandbox credentials throughout.

### 5b. Scheduled jobs

`vercel.json` declares two hourly cron jobs:

| Path | Schedule | What it does |
|---|---|---|
| `/api/cron/weekly-email` | `0 * * * *` | Syncs and sends each customer's Weekly Profit Brief at their chosen local day/hour |
| `/api/cron/lifecycle` | `0 * * * *` | Trial emails, trial expiry, referral reward qualification, testimonial requests |

Both run hourly so each customer's own timezone preference works without a cron entry per
customer, and both are safe to run repeatedly, every email is guarded by a unique dedupe
key and every reward by a unique constraint.

**Cron jobs require a Vercel Pro plan.** Confirm the project is on Pro, and that
`CRON_SECRET` is set in Production, without it, both endpoints reject every request
(they fail closed by design rather than becoming publicly callable).

### 5c. Custom domain

`jobprofitai.com` is still unconnected as of the last launch-plan update.

1. Vercel → **Settings → Domains** → add `jobprofitai.com` and `www.jobprofitai.com`.
2. Update DNS at your registrar as Vercel instructs.
3. Once live, update **all** of these to the real domain: `APP_URL`, `QBO_REDIRECT_URI`,
   the Intuit Production Redirect URI and App URLs, and the Stripe webhook endpoint URL.
   Missing any one of them breaks that integration silently.

---

## 6. Post-deploy smoke test

Run through this on the live site after deploying.

**Marketing (logged out)**

- [ ] `/` loads, hero and dashboard preview render, mobile layout works
- [ ] `/pricing` shows exactly two plans, $149 and $299, no Starter tier anywhere
- [ ] `/how-it-works`, `/security`, `/partners`, `/contact`, `/privacy`, `/terms` all load
- [ ] Logo, favicon and social preview image all appear
- [ ] `/sitemap.xml` and `/robots.txt` return the production domain

**Contact**

- [ ] Submit the contact form → success state appears
- [ ] The message arrives at `support@jobprofitai.com`
- [ ] Replying to it goes back to the submitter (Reply-To)
- [ ] The submitter receives the "We received your message" confirmation
- [ ] The submission appears under `/dashboard/admin/contact`

**Signup and trial**

- [ ] Create an account, no credit card requested anywhere
- [ ] Welcome email arrives
- [ ] Billing page shows "14 days remaining"
- [ ] Connect a real QuickBooks company; sync and analysis complete
- [ ] `/dashboard/admin/trials` shows the account as activated

**Billing (test mode first)**

- [ ] Checkout works for $149 and for $299
- [ ] After payment, the plan and status update within seconds (webhook working)
- [ ] Stripe → Webhooks shows 200 responses, no failures
- [ ] "Manage Billing" opens the Stripe portal
- [ ] Cancelling in the portal is reflected in the app

**Entitlements**

- [ ] Manually set a test account's `trialEndsAt` to the past in Neon
- [ ] Dashboard shows the "trial has ended" upgrade screen, not an error
- [ ] Billing and Settings remain reachable; QuickBooks can still be disconnected
- [ ] `POST /api/quickbooks/sync` returns 402, not data

**Referrals and partners**

- [ ] `/dashboard/referrals` shows a referral link; `/r/CODE` redirects to signup
- [ ] Signing up through the link attributes the referral (visible in admin)
- [ ] Apply to the partner program; approve it from `/dashboard/admin/partners`
- [ ] The approval email arrives with the partner link

**Security**

- [ ] `/dashboard/admin` returns 404 for a non-admin account
- [ ] `GET /api/cron/lifecycle` without the bearer token returns 401
- [ ] `POST /api/stripe/webhook` with a bogus signature returns 400

---

## 7. Known gaps. Things to decide, not bugs

These are deliberate and documented in the product; none of them are half-finished code.

1. **Partner payouts are a ledger, not an automated payout system.** There is no Stripe
   Connect integration, no partner identity verification and no 1099 reporting. An admin
   records payouts made by other means. The partner-facing UI states this plainly. Adding
   Stripe Connect later means writing a payout executor against the existing ledger, not
   redesigning it.

2. **No annual billing and no enterprise tier.** Monthly only, two plans. The pricing
   page says so.

3. **Legal pages are working drafts.** `/privacy` and `/terms` predate this work and are
   flagged inline as not attorney-reviewed. They need a lawyer before you take money from
   strangers, particularly now that payments and a partner commission programme exist.

4. **No testimonials or customer logos anywhere**, by design. There are no real ones yet,
   and inventing them was off the table. The testimonial request email exists and fires
   after ~3 weeks of genuine paid usage; add real quotes to the site once you have them.

5. **Cost-tracking mode.** The sync implements QuickBooks *Projects* mode. Classes mode is
   still a TODO in `src/lib/quickbooksSync.ts`. Worth knowing before onboarding a
   contractor who tracks job cost by Class.

6. **`companyName`** is now fetched from QuickBooks on connect (previously never
   populated). Existing connections made before this change will still show a realm ID
   until they reconnect.

---

## 8. Quick reference

```bash
# Local setup
npm install && npx prisma generate && npx prisma db push
npm run dev

# Verify before pushing
npm run test
npm run build

# Generate secrets
openssl rand -base64 32
```

Support address used throughout the product: **support@jobprofitai.com**
