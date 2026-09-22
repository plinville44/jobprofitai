# JobProfitAI. Production Cutover

Everything in this document is an **external action you have to perform yourself**, in
Vercel, Stripe, Intuit, Resend or Neon. None of it can be done from the codebase, and
none of it has been done for you.

**Status as of 2026-09-17**

| Section | State |
| --- | --- |
| 1. Neon | Done. Launch plan, `production` branch. |
| 2. Stripe | **Test keys only. This is the remaining work.** |
| 3. Intuit / QuickBooks | Done and verified end to end against a real company. |
| 4. Resend | Done. Domain verified, mail delivering. |
| 5. Vercel | Done. Domain live, env vars set, crons scheduled. |

So the sections are no longer all "not started". Read the status line at the top of each
one before doing anything in it. Section 2 is the only one where "create" and "set" still
mean what they say.

**The deadline that matters:** the founder's own trial ends 24 September 2026. Live
Stripe has to work before anyone can pay.

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
   referral views and distort every conversion number you look at. More than cosmetic:
   the hourly lifecycle cron finds their long-expired trials on every run and tries to
   send trial-expired mail to addresses that do not exist. Once `RESEND_API_KEY` is set,
   that is repeated hard bounces on a brand-new sending domain, which is the fastest way
   to damage deliverability before the first real customer email goes out. Delete them
   before verifying the Resend domain, not after.

   **Check which branch the SQL editor is pointed at before running a delete or trusting
   a verification query.** Neon's editor remembers a branch selection, and a snapshot
   branch taken after a delete returns exactly the zeros that a successful delete would.
   A count alone cannot tell the two apart. Verify with something that names what is
   actually there:

   ```sql
   select current_database(),
          (select count(*) from "User") as users,
          (select string_agg(email, ', ') from "User") as remaining_emails;
   ```

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
- **Payload style: Snapshot.** The default. "Thin" payloads send only identifiers, and
  the handlers read `event.data.object` directly, so a thin payload would arrive nearly
  empty and every handler would quietly do nothing.
- **API version:** whatever Stripe offers. As of September 2026 a new account can only
  select `2026-08-26.dahlia` or a preview; `2024-06-20` is no longer available. The
  handlers read every version-sensitive field from both the old and new locations
  (`invoiceSubscriptionId`, `invoiceMetadataUserId`, `subscriptionPeriodEnd` in
  `webhookHandlers.ts`, `isSubscriptionLine` in `billing.ts`), so either works. Do not
  "simplify" those helpers back to a single shape. Three fields moved between versions
  and all three failed silently: two produced no error at all, and the third wrote a
  partner commission of $0 on a real payment.
- Copy the **Signing secret** (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`.

Create a **separate** endpoint in test mode with its own signing secret. The two secrets
are not interchangeable.

### 2b-i. Business name and statement descriptor

Two different fields, and they take different values.

| Field | Where | Value |
|---|---|---|
| Legal business name | Settings → Business details | `PWL Solutions LLC` |
| Public business name | Settings → Public details | `JobProfitAI` |
| Statement descriptor | Settings → Business details | `JOBPROFITAI` |
| Shortened descriptor | Settings → Business details | `JOBPROFIT` |

The legal name must match the EIN and the payout bank account or activation stalls. The
descriptor is what a contractor sees on their card statement; `PWL SOLUTIONS` would not
be recognised and unrecognised descriptors are a leading cause of chargebacks. Set the
shortened descriptor explicitly: left blank, Stripe truncates the main one to ten
characters for card charges, giving `JOBPROFITA`.

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

**Status: done and verified against a real QuickBooks Online company, 2026-09-16/17.**

Production keys were approved 2026-08-12, configured 2026-09-10, and exercised end to
end against a live Plus company on 2026-09-16. Connect, sync, disconnect and reconnect
all work, and the numbers on the dashboard match the books to the dollar.

That testing found six bugs in our own code and four undocumented QuickBooks behaviors.
All six are fixed. The four behaviors are permanent facts about the API and are written
out below, because none of them are in Intuit's documentation and each cost real time to
find.

**Configured:**

1. Production Client ID and Secret from developer.intuit.com → Keys & credentials →
   Production, set in Vercel scoped to **Production**.
2. `QBO_ENVIRONMENT` = `production` and
   `QBO_REDIRECT_URI` = `https://jobprofitai.com/api/quickbooks/callback`, both scoped
   **Production**, both stored as Vercel **Config** rather than Secret so their values
   stay readable. Neither is a credential, and a write-only secret makes the one switch
   that silently changes API hosts impossible to verify.
3. Redirect URI registered under Intuit → Production → Redirect URIs. The OAuth
   Playground's own URI, `https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl`,
   is registered alongside it so the Playground can issue tokens for scripts.
4. Production App URLs off the `jobprofitai.vercel.app` placeholder. Host domain
   `jobprofitai.com`; launch, disconnect and connect/reconnect all point at
   `https://jobprofitai.com/dashboard`, which redirects to `/login` without a session
   and otherwise lands on the page holding the Connect button.

**Verified against the live company:** 7 jobs, 18 cost entries, 7 invoices, 5 estimates.
Per-job revenue, cost, margin and estimate variance correct to the dollar. Cost
categories split correctly across materials, subcontractors, labor and equipment. All
three deliberately messy transactions detected (one untagged expense, one tagged to a
parent customer with three projects, one time entry with no rate). Forecast at
completion, Profit Intelligence cross-job patterns, the AI narrative and the weekly
digest all produced correct figures. Disconnect and reconnect preserved history without
duplicating anything.

---

### Four things QuickBooks does that its documentation does not mention

**1. The query endpoint hides inactive records unless you ask for them.**

`SELECT * FROM Customer` returns only active customers. Inactive ones require
`WHERE Active IN (true, false)`. There is no error and no hint; they are simply absent.

This matters because deactivating a customer is how a job gets marked finished. Without
that clause a job disappeared from the sync at the exact moment it completed, kept
whatever status it last had, and never became "closed". Profit Intelligence only
compares completed jobs, so it could not have produced a single pattern for any
customer. Found by closing six jobs and watching a full sync report "Synced 1 jobs".

**2. Deactivating a customer renames it to "Whatever (deleted)".**

QuickBooks appends that suffix to `DisplayName` when a record goes inactive. Stored
verbatim, every completed job read "Kitchen Remodel (deleted)" forever, including inside
AI-written findings. `cleanCustomerName` in `quickbooksSync.ts` strips it, and only when
the record is actually inactive. Note that `PrintOnCheckName` keeps the original.

**3. Projects have a status that the API does not expose at all.**

Marking a project **Completed** in the QuickBooks interface changes nothing an
integration can see except `LastUpdatedTime`. Confirmed by dumping every field the
Customer endpoint returns for a project. The complete list is:

```
Active, Balance, BalanceWithJobs, BillWithParent, CurrencyRef, DisplayName,
FullyQualifiedName, Id, IsProject, Job, Level, MetaData, ParentRef,
PreferredDeliveryMethod, PrintOnCheckName, ShipAddr, SyncToken, Taxable,
V4IDPseudonym, domain, sparse
```

No status field. The only synced signal is `Active`, and that flips when a customer is
made *inactive*, which is a different act with different side effects (see 2 above).

This is why `Job.statusOverride` exists and why contractors mark jobs complete inside
JobProfitAI. See `src/lib/jobStatus.ts`, which holds the single definition of "finished"
in both its in-memory and Prisma-filter forms. Do not add a third.

`scripts/seed-test-company.js --inspect-jobs` re-runs that field dump if Intuit ever
changes this.

**4. An hourly rate is only stored on time QuickBooks considers billable.**

Send `HourlyRate` on a `NotBillable` TimeActivity and the API accepts it, returns 200,
and stores a rate of zero. No error anywhere.

The sync correctly skips rate-less time, because an hour with no rate has no cost. But
that means a contractor who logs crew hours as non-billable, which is normal on
fixed-price work, has all of that labor silently worth nothing. Data Health now shows
"Time entries with no hourly rate" and explains the fix, and the count is included in
Data Issues. This is a real limitation of the integration, not a bug we can fix.

`scripts/seed-test-company.js --inspect` prints what QuickBooks actually stored for each
time entry, which is the only reliable way to check. The Time Entries screen in
QuickBooks filters by employee by default and will not show vendor time at all.

---

### Composite fields and projected column lists

`SELECT Id, DisplayName, ParentRef FROM Customer` returns `ParentRef` as `{value}` with
no `name`. The same is true of `Line` on Purchase and Bill, which came back as an empty
array for every transaction. Both were silently wrong rather than erroring.

**Use `SELECT *` for any entity with a composite field.** The Customer query now also
resolves each job's client from the parent's own record rather than from
`ParentRef.name`, which is more robust and means a renamed customer shows up renamed at
the next sync.

---

### Sync modes

A person clicking **Sync now** always gets a full read. The hourly cron uses the
incremental CDC path, which is where being light on Intuit's API actually matters.

This is deliberate and worth not undoing. Incremental sync never revisits a record
QuickBooks considers unchanged, so it cannot pick up a field we have newly started
storing or a reading we have newly fixed. That produced two separate "why isn't my data
updating" episodes during testing. There was briefly a second "Re-read everything"
button; it was removed because asking a contractor to understand our two sync modes is
exposing plumbing, and the bigger, more obvious button was the one that could not repair
anything.

---

### Environment and deployment traps

> ⚠️ **Environment variables do not reach the running deployment until you redeploy.**
> On 2026-09-10 all four variables were correct, the site still authorized a sandbox
> company, and the only problem was that the deployment marked Current predated the
> save. Check that timestamp before diagnosing anything else.

> ⚠️ **Tick the Production checkbox.** This project has been bitten three times by
> variables saved without it, producing an "undefined didn't connect" error.

> ⚠️ **`npx tsc --noEmit` lies after a schema change.** It checks against whatever
> Prisma client was generated last time. `npm run build` runs `prisma generate` first.
> After touching `schema.prisma`, trust the build, not `tsc` alone.

> ⚠️ **Preview cannot test QuickBooks.** All four QuickBooks variables are scoped
> Production only. To restore sandbox testing, add Preview-scoped rows with the
> Development ID and Secret, `QBO_ENVIRONMENT` = `sandbox`, and a `QBO_REDIRECT_URI`
> pointing at the preview host registered in the Intuit Development settings.

**How to verify the environment without owning a QBO company.** Click Connect to
QuickBooks on the live site and read the `client_id=` parameter in the Intuit consent URL
before authorizing. `buildAuthorizeUrl` puts `QBO_CLIENT_ID` straight into that URL. Two
limits: it proves the client ID only, since `QBO_ENVIRONMENT` never appears there; and if
the consent screen offers a **sandbox** company, the deployment is still on Development
keys, because sandbox companies exist only under the development client ID.

**Flipping `QBO_ENVIRONMENT` breaks existing sandbox connections, by design.** It is a
single global switch. `QuickBooksConnection.environment` is written on every connection
but read nowhere, so there is no per-connection fallback: a row holding sandbox tokens
starts calling the production API, gets a 401, and shows "reconnect required"
permanently. Clear out sandbox connections before flipping.

**Intuit does not tell you when a customer disconnects from their side.** The Disconnect
URL is a page their browser is sent to, not a webhook. The database keeps thinking the
connection is live until the next sync, when the token refresh returns `invalid_grant`
and `ReconnectRequiredError` surfaces a reconnect prompt. Correct, but delayed.

---

### The test company and its seeder

`scripts/seed-test-company.js` creates a fixed set of seven jobs with invoices, expenses,
bills, time entries and three deliberate data problems, in a real QuickBooks company via
the API. It reuses anything that already exists and marks everything it writes in
`PrivateNote`, so a second run skips rather than doubling amounts.

Modes: `--dry-run`, `--close`, `--fix-time`, `--inspect`, `--inspect-jobs`.

Get a production token from developer.intuit.com → **OAuth 2.0 Playground** (note the
URL is `/app/developer/playground`, with "developer" twice). Tokens last 60 minutes.

The company needs **Plus**, not Simple Start or Essentials, because the sync reads
Projects. QuickBooks Online Plus is $140/month as of 1 August 2026.

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
- [x] Connect a real QuickBooks company; sync and analysis complete
- [ ] `/dashboard/admin/trials` shows the account as activated

**QuickBooks, verified 2026-09-16 against a live Plus company**

- [x] Connect, sync, disconnect, reconnect. History survives, nothing duplicates
- [x] Per-job revenue, cost, margin and estimate variance match the books to the dollar
- [x] Costs split across materials, subcontractors, labor and equipment
- [x] A job with revenue and no costs reads "Profitability unavailable", never a margin
- [x] Data Health counts the untagged expense, the parent-tagged cost and the rate-less
      time entry
- [x] Forecast at completion on an open job
- [x] Profit Intelligence finds a cross-job pattern; every figure traces to a real job
- [x] Weekly digest narrative, generated on demand, matches the dashboard
- [ ] Weekly digest **email**, delivered by the cron on the configured day and hour
- [ ] A contractor with more than 1000 customers or transactions (see Known gaps)

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

7. **Marking a job finished is manual, and always will be.** QuickBooks does not expose
   project status through its API at all (see section 3). Contractors mark jobs complete
   in JobProfitAI, on the job page or in bulk from the jobs list. The onboarding email
   says so explicitly, because a customer who assumes it carries over from QuickBooks
   will finish job after job and watch Profit Intelligence stay empty.

8. **No pagination. Every sync query is capped at `MAXRESULTS 1000`.** A contractor with
   more than a thousand customers, or more than a thousand expenses, is silently
   truncated: no error, just missing data, and every number downstream quietly wrong.
   Most small contractors are nowhere near this. A busy remodeler several years in could
   pass it on expenses without noticing. **This is the most likely way the product gives
   a paying customer a wrong number**, and it should be fixed before any customer with a
   large history is onboarded.

9. **Labor logged as non-billable time carries no cost.** QuickBooks only stores an
   hourly rate on billable time (section 3, item 4). Those hours are real work counted as
   zero. Data Health surfaces the count and explains both fixes (set a rate, or record
   the labor as a bill). Not fixable from our side.

10. **A password reset does not sign out other devices.** Sessions are stateless JWTs.
    Revoking them would need a `passwordChangedAt` column and a database read inside
    `getSession` on every request. Documented rather than hidden.

11. ~~**Signup has no email verification.**~~ **Fixed 2026-09-22.** Signup now sends a
    verification link (48 hours, single use, hashed at rest, 5 per hour). Two things wait
    on it, and only two: the admin area (allowlisted *and* verified, which closes the
    claimable-admin-slot hole) and the Weekly Profit Brief (not sent until the owner is
    verified, so a signup typo can't send job financials to a stranger). Everything else
    works unverified, with a banner. Completing a password reset also verifies, since it
    proves the same thing. The welcome email now follows verification instead of signup.
    Accounts created before this shipped start unverified, including yours: verify from
    the banner or you'll lose the Admin link and your brief. See
    `src/lib/emailVerification.ts`.

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
