import Link from "next/link";
import { redirect } from "next/navigation";
import { getAccount } from "@/lib/account";
import { prisma } from "@/lib/prisma";
import { canConnectAnotherCompany, getEntitlements, getUsageAgainstLimits } from "@/lib/entitlements";
import { NO_PLAN_STATUS, getTrialState } from "@/lib/trial";
import { pausedCompaniesMessage, pausedCompanySummary, planFit } from "@/lib/planLimits";
import { getReferralSummary } from "@/lib/referrals";
import {
  PLANS,
  PLAN_LIST,
  firmBillableCompanies,
  REFERRAL_QUALIFY_DAYS,
  SUBSCRIPTION_STATUS_LABELS,
  TRIAL_EXTENSION_DAYS,
  type PlanId,
} from "@/lib/plans";
import { isPlanOffered, isStripeConfigured } from "@/lib/stripe/client";
import { DEFAULT_TIME_ZONE, NO_VALUE, formatDateTime, formatCents } from "@/lib/format";
import { CheckoutButton, ManageBillingButton } from "./BillingActions";

export const dynamic = "force-dynamic";

/** Shared, so every screen shows the same amount to the cent. */
const money = formatCents;

function Panel({
  title,
  children,
  tone = "default",
}: {
  title?: string;
  children: React.ReactNode;
  tone?: "default" | "warning" | "critical" | "positive";
}) {
  const tones = {
    default: "border-gray-200 bg-white",
    warning: "border-amber-300 bg-amber-50",
    critical: "border-red-300 bg-red-50",
    positive: "border-green-300 bg-green-50",
  } as const;
  return (
    <section className={`rounded-xl border p-6 ${tones[tone]}`}>
      {title ? <h2 className="text-base font-semibold text-navy">{title}</h2> : null}
      <div className={title ? "mt-3" : ""}>{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-gray-100 py-2.5 last:border-b-0">
      <dt className="text-sm text-gray-600">{label}</dt>
      <dd className="text-sm font-medium text-navy">{value}</dd>
    </div>
  );
}

const STATUS_LABELS = SUBSCRIPTION_STATUS_LABELS;

export default async function BillingPage(props: {
  // Next.js 16: searchParams arrives as a Promise.
  searchParams: Promise<{ checkout?: string; limit?: string }>;
}) {
  const searchParams = await props.searchParams;
  const account = await getAccount();
  if (!account) redirect("/login");
  // A client's view-only login has no settings or billing of its own.
  if (account.role === "client") redirect("/dashboard");

  // ?limit= is a code, never text to print: the message is worked out here,
  // so a link can't put words of its choosing on this page.
  let limitNotice: string | null = null;
  if (searchParams?.limit === "trial_used") {
    limitNotice = "That QuickBooks company has already had a free trial of JobProfitAI. Choose a plan to connect it.";
  } else if (searchParams?.limit) {
    const permission = await canConnectAnotherCompany(account.ownerId);
    limitNotice = permission.allowed
      ? null
      : permission.reason ?? "Your plan has no room for another QuickBooks company.";
  }
  const limitTitle = searchParams?.limit === "trial_used" ? "Free trial already used" : "Plan limit reached";

  if (account.role !== "owner") {
    const owner = await prisma.user.findUnique({ where: { id: account.ownerId }, select: { email: true } });
    return (
      <main className="space-y-6">
        <h1 className="text-2xl font-bold text-navy">Billing</h1>
        {/* A team member sent here by the company limit sees why, and who can change it. */}
        {limitNotice ? (
          <Panel tone="warning" title={limitTitle}>
            <p className="text-sm text-amber-900">{limitNotice}</p>
            <p className="mt-2 text-sm text-amber-900">
              Only the account owner{owner?.email ? ` (${owner.email})` : ""} can change the plan.
            </p>
          </Panel>
        ) : null}
        <p className="text-gray-600">
          Billing for this account is managed by its owner{owner?.email ? ` (${owner.email})` : ""}. Your access comes
          with their plan.
        </p>
      </main>
    );
  }

  const [entitlements, trial, subscription, connection] = await Promise.all([
    getEntitlements(account.ownerId),
    getTrialState(account.ownerId),
    prisma.subscription.findUnique({ where: { userId: account.ownerId } }),
    prisma.quickBooksConnection.findFirst({
      where: { userId: account.ownerId, disconnectedAt: null },
      select: { emailTimezone: true },
    }),
  ]);
  // Trial and billing dates are moments, shown in the account's own zone
  // and labelled. "Full access through Sep 16" was printed from a UTC date
  // for a trial that ended at 7pm Pacific on Sep 15.
  const timeZone = connection?.emailTimezone ?? DEFAULT_TIME_ZONE;

  const [usage, referrals, pausedSummary] = await Promise.all([
    getUsageAgainstLimits(account.ownerId, entitlements),
    getReferralSummary(account.ownerId),
    pausedCompanySummary(account.ownerId),
  ]);

  const stripeReady = isStripeConfigured();
  const currentPlan: PlanId | null =
    entitlements.plan === "profit_intelligence" || entitlements.plan === "profit_intelligence_pro" || entitlements.plan === "firm"
      ? entitlements.plan
      : null;
  // Firm: billed per connected company, four at least.
  const firmOffered = isPlanOffered("firm");
  const firmCompanies = subscription?.quantity ?? firmBillableCompanies(usage.connections);
  const firmStartCompanies = firmBillableCompanies(usage.connections);
  const isPaid = entitlements.access === "active" || entitlements.access === "past_due";
  // The owner's own login: every feature, never billed. A Stripe
  // subscription left on it (a test one, say) is shown for what it is.
  const complimentary = entitlements.access === "complimentary";
  const leftoverSubscription =
    complimentary && subscription?.stripeSubscriptionId && ["active", "past_due", "trialing"].includes(subscription.status)
      ? subscription
      : null;

  // Companies past the plan's company limit (src/lib/planLimits.ts). Only
  // while the plan is live: on a lapsed account nothing syncs anyway.
  const paused = entitlements.active && !complimentary ? pausedSummary.paused : [];
  const proCovers = PLANS.profit_intelligence_pro.limits.maxConnections;
  const firmCovers = PLANS.firm.limits.maxConnections;
  // The way out that fits this account, besides disconnecting companies.
  const pausedPlanHint = entitlements.trialing
    ? firmOffered && usage.connections <= firmCovers
      ? `Or choose the ${PLANS.firm.name} plan below, which covers up to ${firmCovers} companies. Choosing it during your trial starts billing that day.`
      : "Or email support@jobprofitai.com about a plan that covers them all."
    : currentPlan === "profit_intelligence" && usage.connections <= proCovers
      ? `Or switch to ${PLANS.profit_intelligence_pro.name}, which covers ${proCovers}, from Manage Billing.`
      : currentPlan !== "firm" && firmOffered && usage.connections <= firmCovers
        ? `Or email support@jobprofitai.com to move to the ${PLANS.firm.name} plan, which covers up to ${firmCovers}.`
        : "Or email support@jobprofitai.com about a plan that covers them all.";

  // What the account already uses, shown on the plan chooser so a plan that
  // can't cover it is ruled out before checkout rather than refused after.
  const usageLine = `You have ${usage.connections} QuickBooks ${usage.connections === 1 ? "company" : "companies"} and ${usage.activeJobs} open ${usage.activeJobs === 1 ? "job" : "jobs"}.`;
  const firmFit = planFit(PLANS.firm, usage);
  // A paying Pro customer can move to the 1-company plan in Stripe's portal;
  // say before they do what that would pause.
  const downgradePauses =
    isPaid && currentPlan === "profit_intelligence_pro"
      ? Math.max(0, usage.connections - PLANS.profit_intelligence.limits.maxConnections)
      : 0;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-navy">Billing &amp; Plan</h1>
        <p className="mt-1 text-sm text-gray-600">
          Manage your subscription, see your plan limits, and track referral credits.
        </p>
      </header>

      {/* Redirect-back notices from Stripe Checkout and the plan-limit gate. */}
      {searchParams?.checkout === "success" ? (
        <Panel tone="positive">
          <p className="text-sm text-green-900">
            <strong>Payment received.</strong> Your subscription is being activated. If the plan
            below still says trial, give it a few seconds and refresh: Stripe confirms
            subscriptions to us in the background.
          </p>
        </Panel>
      ) : null}
      {searchParams?.checkout === "canceled" ? (
        <Panel tone="warning">
          <p className="text-sm text-amber-900">
            Checkout was canceled and you haven&rsquo;t been charged.
          </p>
        </Panel>
      ) : null}
      {limitNotice ? (
        <Panel tone="warning" title={limitTitle}>
          <p className="text-sm text-amber-900">{limitNotice}</p>
        </Panel>
      ) : null}

      {paused.length > 0 ? (
        <Panel tone="warning" title="Some companies are paused">
          <p className="text-sm text-amber-900">
            {pausedCompaniesMessage(
              paused.map((c) => c.name),
              pausedSummary.maxConnections
            )}
          </p>
          <p className="mt-2 text-sm text-amber-900">
            Nothing is deleted: a paused company keeps its figures and stays on your dashboard, but it doesn&rsquo;t
            sync with QuickBooks or send its Weekly Profit Brief or alerts. Your plan covers the companies you connected
            first.
          </p>
          <p className="mt-2 text-sm text-amber-900">
            <Link href="/dashboard/settings" className="font-semibold underline">
              Disconnect companies you no longer need in Settings.
            </Link>{" "}
            {pausedPlanHint}
          </p>
        </Panel>
      ) : null}

      {/* ── Trial state ──────────────────────────────────────────── */}
      {complimentary ? (
        <Panel tone="positive" title="Complimentary access">
          <p className="text-sm text-green-900">
            This login is on the JobProfitAI owner list, so it has every {PLANS.profit_intelligence_pro.name} feature
            at no charge, permanently. Nothing is billed, and it doesn&rsquo;t depend on a subscription.
          </p>
          {leftoverSubscription ? (
            <div className="mt-3 border-t border-green-200 pt-3 text-sm text-green-900">
              <p>
                {leftoverSubscription.cancelAtPeriodEnd && leftoverSubscription.currentPeriodEnd
                  ? `You still have a Stripe subscription on file. It's set to end ${formatDateTime(leftoverSubscription.currentPeriodEnd, timeZone)} and won't charge you again. Your access doesn't change when it ends.`
                  : "You still have a Stripe subscription on file, and it's still billing you. You don't need it for access: cancel it in Manage Billing."}
              </p>
              <div className="mt-3">
                <ManageBillingButton />
              </div>
            </div>
          ) : null}
        </Panel>
      ) : null}

      {!complimentary && trial.onTrial ? (
        <Panel tone={trial.daysRemaining <= 3 ? "warning" : "default"}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-lg font-semibold text-navy">
                {trial.daysRemaining} {trial.daysRemaining === 1 ? "day" : "days"} remaining in your
                free trial
              </p>
              <p className="mt-1 text-sm text-gray-600">
                Your trial ends {formatDateTime(trial.trialEndsAt, timeZone)}. No credit card on file.
                {trial.extensionClaimed ? ` Includes your ${TRIAL_EXTENSION_DAYS}-day extension.` : ""}
              </p>
            </div>
            {trial.extensionOffered ? (
              <Link
                href="/dashboard/billing/feedback"
                className="rounded-lg bg-navy px-5 py-2.5 text-sm font-semibold text-white hover:bg-gray-800"
              >
                Get {TRIAL_EXTENSION_DAYS} More Days Free
              </Link>
            ) : null}
          </div>

          {trial.extensionOffered ? (
            <p className="mt-3 border-t border-gray-200 pt-3 text-sm text-gray-600">
              Give us 5 minutes of feedback and we&rsquo;ll extend your trial another{" "}
              {TRIAL_EXTENSION_DAYS} days. No testimonial required, just honest answers.
            </p>
          ) : null}

          {!trial.activated ? (
            <p className="mt-3 border-t border-gray-200 pt-3 text-sm text-gray-600">
              {!trial.quickbooksConnected
                ? "Connect QuickBooks to start seeing your job profitability."
                : "Run your first analysis to see what your numbers say."}{" "}
              <Link href="/dashboard" className="font-medium text-brand hover:underline">
                Go to your dashboard
              </Link>
            </p>
          ) : null}
        </Panel>
      ) : null}

      {trial.expired && !isPaid && !complimentary ? (
        <Panel tone="critical">
          <p className="text-lg font-semibold text-red-900">Your JobProfitAI trial has ended.</p>
          <p className="mt-1 text-sm text-red-800">
            Choose a plan to continue accessing your profit intelligence. Nothing has been
            deleted: your account, QuickBooks connection and analyzed jobs are all still here.
          </p>
          {/* Still claimable for a few days after expiry, and this panel
              used to be one of the places that never said so. */}
          {trial.extensionOffered ? (
            <p className="mt-3 text-sm text-red-800">
              Not ready to decide?{" "}
              <Link href="/dashboard/billing/feedback" className="font-semibold underline">
                Answer a few questions for {TRIAL_EXTENSION_DAYS} more days free.
              </Link>
            </p>
          ) : null}
        </Panel>
      ) : null}

      {entitlements.paymentIssue ? (
        <Panel
          tone={entitlements.access === "past_due" ? "warning" : "critical"}
          title="There's a problem with your payment"
        >
          <p className="text-sm text-amber-900">
            {entitlements.access === "past_due"
              ? "Your most recent payment didn\u2019t go through, usually an expired card. Your account stays active while Stripe retries, and updating your card now avoids any interruption."
              : "Your payment didn\u2019t go through after several attempts, so access is paused. Update your card to turn everything back on. Nothing has been deleted."}
          </p>
          <div className="mt-4">
            <ManageBillingButton label="Update payment method" />
          </div>
        </Panel>
      ) : null}

      {/* ── Current plan ─────────────────────────────────────────── */}
      <Panel title="Current plan">
        <dl>
          <Row
            label="Plan"
            value={
              complimentary
                ? `${PLANS.profit_intelligence_pro.name}, complimentary`
                : entitlements.trialing
                ? "Free trial (full access)"
                : currentPlan
                  ? PLANS[currentPlan].name
                  : entitlements.planName
            }
          />
          <Row
            label="Monthly price"
            value={
              complimentary
                ? "$0, never billed"
                : entitlements.trialing
                ? "$0 during trial"
                : isPaid && currentPlan === "firm"
                  ? `${formatCents(PLANS.firm.priceCents * firmCompanies)}/month (${firmCompanies} companies at ${PLANS.firm.priceLabel}, ${PLANS.firm.perCompany!.minCompanies} minimum)`
                  : isPaid && currentPlan
                  ? `${PLANS[currentPlan].priceLabel}/month`
                  : NO_VALUE
            }
          />
          <Row
            label="Status"
            value={
              complimentary
                ? "Complimentary (owner login)"
                : subscription?.status === NO_PLAN_STATUS
                  ? "No plan"
                  : STATUS_LABELS[subscription?.status ?? ""] ?? subscription?.status ?? NO_VALUE
            }
          />
          {entitlements.currentPeriodEnd ? (
            <Row
              label={entitlements.cancelAtPeriodEnd ? "Access ends" : "Next billing date"}
              value={formatDateTime(entitlements.currentPeriodEnd, timeZone)}
            />
          ) : null}
          <Row
            label="QuickBooks companies"
            value={`${usage.connections} of ${usage.maxConnections}`}
          />
          <Row
            label="Active jobs"
            value={`${usage.activeJobs}${usage.maxActiveJobs == null ? " (unlimited)" : ` of ${usage.maxActiveJobs}`}`}
          />
        </dl>

        {entitlements.cancelAtPeriodEnd ? (
          <p className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
            Your subscription is set to cancel at the end of the current period. You keep full
            access until then, and you can reactivate any time from Manage Billing.
          </p>
        ) : null}

        {usage.overConnectionLimit && !complimentary && paused.length === 0 ? (
          <p className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
            You have {usage.connections} QuickBooks companies connected and your plan covers {usage.maxConnections}.
            Disconnect the ones you no longer need in Settings, or choose a plan that covers them all.
          </p>
        ) : null}

        {usage.overJobLimit ? (
          <p className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
            You have {usage.activeJobs} active jobs and your plan covers {usage.maxActiveJobs}.
            Nothing has been removed and all your data is intact. Upgrading to{" "}
            {PLANS.profit_intelligence_pro.name} covers unlimited jobs.
          </p>
        ) : null}

        {isPaid ? (
          <div className="mt-5 flex flex-wrap gap-3">
            <ManageBillingButton />
            <span className="self-center text-xs text-gray-500">
              {currentPlan === "firm"
                ? "Update your card, download invoices or cancel, all self-serve through Stripe."
                : "Update your card, download invoices, change plan or cancel, all self-serve through Stripe."}
            </span>
          </div>
        ) : null}
      </Panel>

      {/* ── Choose / change plan ─────────────────────────────────── */}
      {complimentary ? null : (
        <Panel title={isPaid ? "Change your plan" : "Choose your plan"}>
          {!stripeReady ? (
            <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
              Billing isn&rsquo;t fully configured in this environment yet. Please contact{" "}
              <a href="mailto:support@jobprofitai.com" className="font-medium underline">
                support@jobprofitai.com
              </a>
              .
            </p>
          ) : isPaid ? (
            <p className="text-sm text-gray-600">
              {currentPlan === "firm" ? (
                <>
                  You&rsquo;re billed for each connected QuickBooks company ({PLANS.firm.perCompany!.minCompanies}{" "}
                  minimum). Connecting or disconnecting a company updates the bill on its own, prorated, and a company
                  that hasn&rsquo;t synced for over a week because its QuickBooks access was cut off isn&rsquo;t billed.
                  To move off the Firm plan, email{" "}
                  <a href="mailto:support@jobprofitai.com" className="font-medium text-brand underline">
                    support@jobprofitai.com
                  </a>
                  .
                </>
              ) : (
                <>
                  Switch plans from <span className="font-medium text-navy">Manage Billing</span> above. Stripe
                  prorates the change automatically, in either direction. Keeping the books for several contractors?
                  To move to the Firm plan, email{" "}
                  <a href="mailto:support@jobprofitai.com" className="font-medium text-brand underline">
                    support@jobprofitai.com
                  </a>
                  .
                </>
              )}
            </p>
          ) : null}
          {stripeReady && isPaid && downgradePauses > 0 ? (
            <p className="mt-3 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
              {usageLine} {PLANS.profit_intelligence.name} covers{" "}
              {PLANS.profit_intelligence.limits.maxConnections} company, so switching to it would pause{" "}
              {downgradePauses} of them: they&rsquo;d keep their figures but stop syncing until you disconnect some or
              move back.
            </p>
          ) : null}
          {!stripeReady || isPaid ? null : (
            <>
              <p className="mb-4 text-sm text-gray-600">{usageLine}</p>
              <div className="grid gap-5 lg:grid-cols-2">
                {PLAN_LIST.map((plan) => {
                  // Disabled with the reason when the plan can't cover the
                  // companies already connected (checkout would refuse it);
                  // a warning only for the open-job limit, which isn't enforced.
                  const fit = planFit(plan, usage);
                  return (
                    <div
                      key={plan.id}
                      className={`rounded-xl border p-5 ${
                        plan.mostPopular && fit.fits ? "border-brand" : "border-gray-200"
                      }`}
                    >
                      <div className="flex items-baseline justify-between">
                        <h3 className="font-semibold text-navy">{plan.name}</h3>
                        {plan.mostPopular ? (
                          <span className="rounded-full bg-brand-light px-2.5 py-0.5 text-xs font-semibold text-brand">
                            Most Popular
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-2 text-3xl font-bold text-navy">
                        {plan.priceLabel}
                        <span className="text-base font-normal text-gray-500">/month</span>
                      </p>
                      <p className="mt-2 text-sm text-gray-600">{plan.bestFor}</p>
                      <p className="mt-2 text-sm text-gray-600">
                        Covers {plan.limits.maxConnections} QuickBooks{" "}
                        {plan.limits.maxConnections === 1 ? "company" : "companies"} and{" "}
                        {plan.limits.maxActiveJobs == null ? "unlimited open jobs" : `up to ${plan.limits.maxActiveJobs} open jobs`}.
                      </p>
                      {fit.warning ? (
                        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{fit.warning}</p>
                      ) : null}
                      <CheckoutButton
                        plan={plan.id}
                        label={`Choose ${plan.name}`}
                        variant={plan.mostPopular && fit.fits ? "primary" : "secondary"}
                        className="mt-5"
                        disabledReason={fit.reason}
                      />
                    </div>
                  );
                })}
              </div>
              {firmOffered ? (
                <div className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-gray-200 p-5">
                  <div className="max-w-2xl">
                    <h3 className="font-semibold text-navy">{PLANS.firm.name}, for bookkeepers and accountants</h3>
                    <p className="mt-1 text-sm text-gray-600">
                      {PLANS.firm.priceLabel} per client company a month, {PLANS.firm.perCompany!.minCompanies} minimum:
                      everything in Pro for every client, plus view-only logins for your clients and room for up to{" "}
                      {PLANS.firm.limits.maxConnections} companies. With{" "}
                      {usage.connections} connected {usage.connections === 1 ? "company" : "companies"} it starts at{" "}
                      {formatCents(PLANS.firm.priceCents * firmStartCompanies)} a month, and adjusts as you connect or
                      disconnect companies.
                    </p>
                  </div>
                  <CheckoutButton plan="firm" label="Choose Firm" variant="secondary" disabledReason={firmFit.reason} />
                </div>
              ) : null}
              <p className="mt-4 text-xs text-gray-500">
                {entitlements.trialing
                  ? "Choosing a plan during your free trial starts billing that day, and the rest of the trial ends. "
                  : ""}
                Plans renew automatically every month at the price shown until you cancel. Cancel
                anytime from Manage Billing on this page; cancellation takes effect at the end of the
                month you have already paid for. See our{" "}
                <Link href="/terms" className="font-medium text-brand hover:underline">
                  Terms of Service
                </Link>
                .{" "}
                <Link href="/pricing" className="font-medium text-brand hover:underline">
                  Compare plans in detail
                </Link>
              </p>
            </>
          )}
        </Panel>
      )}

      {/* ── Referrals ────────────────────────────────────────────── */}
      <Panel title="Referral credits">
        <p className="text-sm text-gray-600">
          Refer someone who becomes a paying customer. Once they&rsquo;ve paid their first monthly renewal and are still
          subscribed at least {REFERRAL_QUALIFY_DAYS} days after their first payment, you earn an account credit worth one
          month of your current plan{currentPlan === "firm" ? `, priced at the Firm minimum of ${PLANS.firm.perCompany!.minCompanies} companies` : ""},
          or what they&rsquo;ve paid us so far if that&rsquo;s less. Credits stack and come off future invoices automatically.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Signed up", value: String(referrals.signedUp) },
            { label: "Converted to paid", value: String(referrals.paying) },
            { label: "Credit earned", value: money(referrals.totalEarnedCents) },
            { label: "Credit applied", value: money(referrals.appliedRewardCents) },
          ].map((stat) => (
            <div key={stat.label} className="rounded-lg border border-gray-200 px-3.5 py-3">
              <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
                {stat.label}
              </div>
              <div className="mt-1 text-lg font-bold text-navy">{stat.value}</div>
            </div>
          ))}
        </div>
        <Link
          href="/dashboard/referrals"
          className="mt-4 inline-block text-sm font-medium text-brand hover:underline"
        >
          Open your referral dashboard &rarr;
        </Link>
      </Panel>

      <p className="text-xs text-gray-500">
        Questions about billing? Email{" "}
        <a href="mailto:support@jobprofitai.com" className="font-medium text-brand hover:underline">
          support@jobprofitai.com
        </a>
        .
      </p>
    </div>
  );
}
