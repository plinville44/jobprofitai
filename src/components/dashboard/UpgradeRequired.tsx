import Link from "next/link";
import { PLAN_LIST, PLANS } from "@/lib/plans";
import { isPlanOffered } from "@/lib/stripe/client";
import type { AccessState } from "@/lib/entitlements";
import { getAccount } from "@/lib/account";

/**
 * What a customer sees instead of a gated page once their trial has ended or
 * their subscription lapsed.
 *
 * The point of this component is that an expired trial should feel like a
 * decision to make, not an error to debug. No 403, no "unauthorized", no
 * dead end - it explains the state, reassures them nothing was deleted
 * (which is the real fear), shows the two plans (and Firm, when it can be
 * bought), and leaves billing, settings, support and QuickBooks
 * disconnection reachable from the nav above it.
 */
export default async function UpgradeRequired({
  access,
  feature = "your profit intelligence",
}: {
  access: AccessState;
  feature?: string;
}) {
  // A client's view-only login can't choose a plan: the account is the
  // bookkeeper's. Tell them who to talk to instead of showing prices.
  const account = await getAccount();
  if (account?.role === "client") {
    return (
      <div className="mx-auto max-w-2xl py-6">
        <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center">
          <h1 className="text-xl font-bold text-navy">This view isn&apos;t available right now</h1>
          <p className="mt-3 text-[15px] leading-relaxed text-gray-600">
            Your view-only access comes through your bookkeeper&apos;s JobProfitAI account, which isn&apos;t active at
            the moment. Nothing has been deleted. Contact your bookkeeper to turn it back on.
          </p>
        </div>
      </div>
    );
  }
  const expiredTrial = access === "trial_expired";
  // Same test as the Billing page: Firm is offered only once its Stripe
  // price is configured, so it's never pointed to when it can't be bought.
  const firmOffered = isPlanOffered("firm");
  // A login with no plan of its own, usually a removed team member or client.
  const noPlan = access === "none";

  return (
    <div className="mx-auto max-w-3xl py-6">
      <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center sm:p-10">
        <h1 className="text-2xl font-bold text-navy sm:text-3xl">
          {expiredTrial
            ? "Your JobProfitAI trial has ended."
            : noPlan
              ? "This login isn't on a plan."
              : "Your subscription is inactive."}
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-[15px] leading-relaxed text-gray-600">
          {noPlan
            ? `Choose a plan to use ${feature} with your own QuickBooks company. If you worked in someone else's JobProfitAI account, ask its owner to invite you again.`
            : `Choose a plan to continue accessing ${feature}.`}
        </p>

        {noPlan ? null : (
          <div className="mx-auto mt-5 max-w-xl rounded-lg bg-gray-50 px-5 py-4">
            <p className="text-sm leading-relaxed text-gray-700">
              <strong className="text-navy">Nothing has been deleted.</strong> Your account, your
              QuickBooks connection and every job analyzed so far are all still here. Subscribing
              turns everything back on exactly as you left it.
            </p>
          </div>
        )}

        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {PLAN_LIST.map((plan) => (
            <div
              key={plan.id}
              className={`rounded-xl border p-5 text-left ${
                plan.mostPopular ? "border-brand" : "border-gray-200"
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="font-semibold text-navy">{plan.name}</h2>
                {plan.mostPopular ? (
                  <span className="rounded-full bg-brand-light px-2.5 py-0.5 text-[11px] font-semibold text-brand">
                    Most Popular
                  </span>
                ) : null}
              </div>
              <p className="mt-2 text-3xl font-bold text-navy">
                {plan.priceLabel}
                <span className="text-base font-normal text-gray-500">/month</span>
              </p>
              <p className="mt-2 text-sm leading-relaxed text-gray-600">{plan.bestFor}</p>
            </div>
          ))}
        </div>

        {firmOffered ? (
          <p className="mt-4 text-left text-sm leading-relaxed text-gray-600">
            <strong className="text-navy">Keeping the books for several contractors?</strong> {PLANS.firm.name} is{" "}
            {PLANS.firm.priceLabel} per client company a month, {PLANS.firm.perCompany!.minCompanies} minimum, with
            everything in {PLANS.profit_intelligence_pro.name} for every client and view-only logins for your clients.
            It&apos;s on the Billing page too.
          </p>
        ) : null}

        <Link
          href="/dashboard/billing"
          className="mt-8 inline-flex items-center justify-center rounded-lg bg-brand px-7 py-3.5 text-base font-semibold text-white transition-colors hover:bg-blue-700"
        >
          Choose Your Plan
        </Link>

        <p className="mt-5 text-sm text-gray-500">
          Month to month. Cancel anytime. Questions?{" "}
          <a
            href="mailto:support@jobprofitai.com"
            className="font-medium text-brand hover:underline"
          >
            support@jobprofitai.com
          </a>
        </p>

        <p className="mt-6 border-t border-gray-100 pt-5 text-xs leading-relaxed text-gray-500">
          You can still reach your{" "}
          <Link href="/dashboard/billing" className="font-medium text-brand hover:underline">
            billing
          </Link>{" "}
          and{" "}
          <Link href="/dashboard/settings" className="font-medium text-brand hover:underline">
            account settings
          </Link>
          , including disconnecting QuickBooks, at any time.
        </p>
      </div>
    </div>
  );
}
