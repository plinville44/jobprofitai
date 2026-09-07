import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEntitlements, getUsageAgainstLimits } from "@/lib/entitlements";
import { getTrialState } from "@/lib/trial";
import { getReferralSummary } from "@/lib/referrals";
import { PLANS, PLAN_LIST, type PlanId } from "@/lib/plans";
import { isStripeConfigured } from "@/lib/stripe/client";
import { NO_VALUE, formatDate } from "@/lib/format";
import { CheckoutButton, ManageBillingButton } from "./BillingActions";

export const dynamic = "force-dynamic";

function money(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

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

const STATUS_LABELS: Record<string, string> = {
  trialing: "Free trial",
  trial_expired: "Trial ended",
  active: "Active",
  past_due: "Payment overdue",
  canceled: "Canceled",
  incomplete: "Incomplete",
  unpaid: "Unpaid",
};

export default async function BillingPage({
  searchParams,
}: {
  searchParams?: { checkout?: string; limit?: string };
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const [entitlements, trial, subscription] = await Promise.all([
    getEntitlements(session.userId),
    getTrialState(session.userId),
    prisma.subscription.findUnique({ where: { userId: session.userId } }),
  ]);

  const [usage, referrals] = await Promise.all([
    getUsageAgainstLimits(session.userId, entitlements),
    getReferralSummary(session.userId),
  ]);

  const stripeReady = isStripeConfigured();
  const currentPlan: PlanId | null =
    entitlements.plan === "profit_intelligence" || entitlements.plan === "profit_intelligence_pro"
      ? entitlements.plan
      : null;
  const isPaid = entitlements.access === "active" || entitlements.access === "past_due";

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
            <strong>Payment received.</strong> Your subscription is being activated, if the
            plan below still says trial, give it a few seconds and refresh. Stripe confirms
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
      {searchParams?.limit ? (
        <Panel tone="warning" title="Plan limit reached">
          <p className="text-sm text-amber-900">{searchParams.limit}</p>
        </Panel>
      ) : null}

      {/* ── Trial state ──────────────────────────────────────────── */}
      {trial.onTrial ? (
        <Panel tone={trial.daysRemaining <= 3 ? "warning" : "default"}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-lg font-semibold text-navy">
                {trial.daysRemaining} {trial.daysRemaining === 1 ? "day" : "days"} remaining in your
                free trial
              </p>
              <p className="mt-1 text-sm text-gray-600">
                Full access through {formatDate(trial.trialEndsAt)}. No credit card on file.
                {trial.extensionClaimed ? " Includes your 14-day extension." : ""}
              </p>
            </div>
            {trial.extensionOffered ? (
              <Link
                href="/dashboard/billing/feedback"
                className="rounded-lg bg-navy px-5 py-2.5 text-sm font-semibold text-white hover:bg-gray-800"
              >
                Get 14 More Days Free
              </Link>
            ) : null}
          </div>

          {trial.extensionOffered ? (
            <p className="mt-3 border-t border-gray-200 pt-3 text-sm text-gray-600">
              Give us 5 minutes of feedback and we&rsquo;ll extend your trial another 14 days. No
              testimonial required, just honest answers.
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

      {trial.expired && !isPaid ? (
        <Panel tone="critical">
          <p className="text-lg font-semibold text-red-900">Your JobProfitAI trial has ended.</p>
          <p className="mt-1 text-sm text-red-800">
            Choose a plan to continue accessing your profit intelligence. Nothing has been deleted
. Your account, QuickBooks connection and analyzed jobs are all still here.
          </p>
        </Panel>
      ) : null}

      {entitlements.paymentIssue ? (
        <Panel tone="warning" title="There's a problem with your payment">
          <p className="text-sm text-amber-900">
            Your most recent payment didn&rsquo;t go through, usually an expired card. Your
            account is still fully active while Stripe retries, but updating your card now avoids
            any interruption.
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
              entitlements.trialing
                ? "Free trial (full access)"
                : currentPlan
                  ? PLANS[currentPlan].name
                  : entitlements.planName
            }
          />
          <Row
            label="Monthly price"
            value={
              entitlements.trialing
                ? "$0 during trial"
                : isPaid && currentPlan
                  ? `${PLANS[currentPlan].priceLabel}/month`
                  : NO_VALUE
            }
          />
          <Row
            label="Status"
            value={STATUS_LABELS[subscription?.status ?? ""] ?? subscription?.status ?? NO_VALUE}
          />
          {entitlements.currentPeriodEnd ? (
            <Row
              label={entitlements.cancelAtPeriodEnd ? "Access ends" : "Next billing date"}
              value={formatDate(entitlements.currentPeriodEnd)}
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
              Update your card, download invoices, change plan or cancel, all self-serve
              through Stripe.
            </span>
          </div>
        ) : null}
      </Panel>

      {/* ── Choose / change plan ─────────────────────────────────── */}
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
            Switch plans from{" "}
            <span className="font-medium text-navy">Manage Billing</span> above. Stripe
            prorates the change automatically, in either direction.
          </p>
        ) : (
          <>
            <div className="grid gap-5 lg:grid-cols-2">
              {PLAN_LIST.map((plan) => (
                <div
                  key={plan.id}
                  className={`rounded-xl border p-5 ${
                    plan.mostPopular ? "border-brand" : "border-gray-200"
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
                  <CheckoutButton
                    plan={plan.id}
                    label={`Choose ${plan.name}`}
                    variant={plan.mostPopular ? "primary" : "secondary"}
                    className="mt-5"
                  />
                </div>
              ))}
            </div>
            <p className="mt-4 text-xs text-gray-500">
              Month to month. Cancel anytime.{" "}
              <Link href="/pricing" className="font-medium text-brand hover:underline">
                Compare plans in detail
              </Link>
            </p>
          </>
        )}
      </Panel>

      {/* ── Referrals ────────────────────────────────────────────── */}
      <Panel title="Referral credits">
        <p className="text-sm text-gray-600">
          Refer a paying customer and earn one free month of your current plan as an account credit.
          Credits stack and come off future invoices automatically.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Signed up", value: String(referrals.signedUp) },
            { label: "Paying", value: String(referrals.paying) },
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
