import Link from "next/link";
import { PLAN_LIST } from "@/lib/plans";
import type { AccessState } from "@/lib/entitlements";

/**
 * What a customer sees instead of a gated page once their trial has ended or
 * their subscription lapsed.
 *
 * The point of this component is that an expired trial should feel like a
 * decision to make, not an error to debug. No 403, no "unauthorized", no
 * dead end - it explains the state, reassures them nothing was deleted
 * (which is the real fear), shows the two plans, and leaves billing,
 * settings, support and QuickBooks disconnection reachable from the nav
 * above it.
 */
export default function UpgradeRequired({
  access,
  feature = "your profit intelligence",
}: {
  access: AccessState;
  feature?: string;
}) {
  const expiredTrial = access === "trial_expired";

  return (
    <div className="mx-auto max-w-3xl py-6">
      <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center sm:p-10">
        <h1 className="text-2xl font-bold text-navy sm:text-3xl">
          {expiredTrial ? "Your JobProfitAI trial has ended." : "Your subscription is inactive."}
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-[15px] leading-relaxed text-gray-600">
          Choose a plan to continue accessing {feature}.
        </p>

        <div className="mx-auto mt-5 max-w-xl rounded-lg bg-gray-50 px-5 py-4">
          <p className="text-sm leading-relaxed text-gray-700">
            <strong className="text-navy">Nothing has been deleted.</strong> Your account, your
            QuickBooks connection and every job analyzed so far are all still here. Subscribing
            turns everything back on exactly as you left it.
          </p>
        </div>

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
          </Link>{" "}
, including disconnecting QuickBooks, at any time.
        </p>
      </div>
    </div>
  );
}
