import Link from "next/link";
import { PLAN_LIST } from "@/lib/plans";
import { CheckIcon } from "./ui";

/**
 * The two launch plans, rendered straight from the plan catalog in
 * src/lib/plans.ts.
 *
 * Reading from the catalog rather than hardcoding copy here is what keeps
 * the pricing page honest: the bullets shown to a prospect are the same
 * array the entitlement layer is built around, so the page cannot drift into
 * advertising a feature the product doesn't grant.
 *
 * There are exactly two plans. No Starter tier, no freemium tier, nothing
 * below $149 - the 14-day trial is what removes purchase friction.
 */
export default function PricingCards({ compact = false }: { compact?: boolean }) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {PLAN_LIST.map((plan) => (
        <div
          key={plan.id}
          className={`relative flex flex-col rounded-2xl border bg-white p-7 sm:p-8 ${
            plan.mostPopular
              ? "border-jp-blue shadow-[0_18px_45px_-28px_rgba(29,78,216,0.55)]"
              : "border-jp-line"
          }`}
        >
          {plan.mostPopular ? (
            <span className="absolute -top-3 left-7 inline-flex items-center rounded-full bg-jp-blue px-3 py-1 text-xs font-semibold text-white">
              Most Popular
            </span>
          ) : null}

          <h3 className="text-xl font-bold text-jp-ink">{plan.name}</h3>
          <p className="mt-2 min-h-[3rem] text-sm leading-relaxed text-jp-slate">{plan.bestFor}</p>

          <div className="mt-5 flex items-baseline gap-1.5">
            <span className="text-4xl font-bold tracking-tight text-jp-ink">{plan.priceLabel}</span>
            <span className="text-base text-jp-muted">/month</span>
          </div>

          <Link
            href="/signup"
            className={`mt-6 inline-flex items-center justify-center rounded-lg px-5 py-3 text-sm font-semibold transition-colors ${
              plan.mostPopular
                ? "bg-jp-blue text-white hover:bg-jp-navy"
                : "border border-jp-line text-jp-ink hover:border-jp-blue hover:text-jp-blue"
            }`}
          >
            Start Free Trial
          </Link>
          <p className="mt-3 text-center text-xs text-jp-muted">
            14 days free. No credit card required.
          </p>

          <ul className={`mt-7 space-y-2.5 ${compact ? "text-sm" : "text-[15px]"}`}>
            {plan.marketingFeatures.map((feature) => (
              <li key={feature} className="flex gap-2.5">
                <CheckIcon />
                <span className="leading-relaxed text-jp-slate">{feature}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
