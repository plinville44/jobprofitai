import type { Metadata } from "next";
import Link from "next/link";
import { ButtonLink, Eyebrow, Faq, FinalCta, Section, SectionHeading } from "@/components/marketing/ui";
import PricingCards from "@/components/marketing/PricingCards";
import { PLANS } from "@/lib/plans";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "JobProfitAI pricing: Profit Intelligence at $149/month and Profit Intelligence Pro at $299/month. 14-day free trial, no credit card required, cancel anytime.",
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: "JobProfitAI Pricing, $149 and $299 per month",
    description:
      "Two plans, both including AI profit insights and recommendations. 14 days free, no credit card required.",
    url: "/pricing",
  },
};

const FAQ_ITEMS = [
  {
    q: "Is a credit card required to start the trial?",
    a: <>No. The 14-day trial needs no card and no payment details. You only enter payment information if you decide to subscribe.</>,
  },
  {
    q: "What happens when the trial ends?",
    a: (
      <>
        The profit intelligence features switch off, but nothing is deleted. Your account, your
        QuickBooks connection and every job analyzed stay exactly where they are. Choosing a plan
        later turns everything back on as you left it.
      </>
    ),
  },
  {
    q: "Can I cancel anytime?",
    a: (
      <>
        Yes. Both plans are month to month. You cancel yourself from your billing settings through
        Stripe&rsquo;s billing portal, no contract, no notice period, no phone call.
      </>
    ),
  },
  {
    q: "Can I switch between plans?",
    a: (
      <>
        Yes, in either direction, from your billing settings. Stripe prorates the change
        automatically. If you move down to a plan that covers fewer jobs or companies than
        you&rsquo;re currently using, nothing is deleted. We show you what&rsquo;s over the limit
        and what that restricts.
      </>
    ),
  },
  {
    q: "What counts as an “active job”?",
    a: (
      <>
        A job that&rsquo;s currently open in your QuickBooks company, a Project or Class still in
        progress. Completed jobs stay in your history and your trend analysis; they don&rsquo;t
        count against the limit.
      </>
    ),
  },
  {
    q: "Do you offer annual billing or an enterprise plan?",
    a: (
      <>
        Not at launch. Both plans are monthly, and these two are the whole lineup. If you need
        something the plans don&rsquo;t cover. More than three QuickBooks companies, for instance, {" "}
        <Link href="/contact" className="font-medium text-jp-blue hover:underline">
          get in touch
        </Link>{" "}
        and we&rsquo;ll talk it through honestly.
      </>
    ),
  },
];

const COMPARISON: { label: string; standard: string; pro: string }[] = [
  { label: "QuickBooks Online companies", standard: "1", pro: "Up to 3" },
  { label: "Active jobs", standard: "Up to 100", pro: "Unlimited" },
  { label: "Job profitability dashboard", standard: "Included", pro: "Included" },
  { label: "Revenue, cost, gross profit & margin by job", standard: "Included", pro: "Included" },
  { label: "Cost breakdown by category", standard: "Included", pro: "Included" },
  { label: "Estimate vs. actual comparison", standard: "Included", pro: "Included" },
  { label: "Margin leak & cost-overrun detection", standard: "Included", pro: "Included" },
  { label: "Historical profitability trends", standard: "Included", pro: "Included" },
  { label: "AI profit insights & recommended actions", standard: "Included", pro: "Included" },
  { label: "Data Health checks", standard: "Included", pro: "Included" },
  { label: "Weekly Profit Brief", standard: "Included", pro: "Included" },
  { label: "Forecast at completion on open jobs", standard: "-", pro: "Included" },
  { label: "Cross-job benchmarking & pattern analysis", standard: "-", pro: "Included" },
  { label: "Company-wide profit opportunity findings", standard: "-", pro: "Included" },
  { label: "Support", standard: "Email support", pro: "Priority support" },
];

export default function PricingPage() {
  return (
    <>
      <Section className="!pb-8">
        <div className="mx-auto max-w-3xl text-center">
          <Eyebrow>Pricing</Eyebrow>
          <h1 className="text-4xl font-bold leading-tight tracking-tight text-jp-ink sm:text-5xl">
            Priced against the profit it protects.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-jp-slate">
            JobProfitAI is built to help contractors uncover profitability issues worth far more
            than the monthly subscription. Find one costly margin problem and it can pay for itself.
          </p>
          <p className="mt-5 text-sm text-jp-muted">
            14-day free trial &middot; No credit card required &middot; Cancel anytime
          </p>
        </div>
      </Section>

      <Section className="!pt-4">
        <PricingCards />
      </Section>

      {/* ── Detailed comparison ─────────────────────────────────────── */}
      <Section tone="surface">
        <SectionHeading
          eyebrow="Compare"
          title="What's in each plan"
          intro="Both plans include the core promise: which jobs make money, which don't, why, and what to consider doing about it. Pro adds scale and forward-looking analysis on top."
          align="center"
        />
        <div className="overflow-x-auto rounded-xl border border-jp-line bg-white">
          <table className="w-full min-w-[600px] text-left text-sm">
            <caption className="sr-only">Feature comparison between JobProfitAI plans</caption>
            <thead>
              <tr className="border-b border-jp-line bg-jp-surface">
                <th scope="col" className="px-5 py-4 font-semibold text-jp-ink">
                  Feature
                </th>
                <th scope="col" className="px-5 py-4 text-center font-semibold text-jp-ink">
                  {PLANS.profit_intelligence.name}
                  <span className="mt-0.5 block text-xs font-normal text-jp-muted">
                    {PLANS.profit_intelligence.priceLabel}/mo
                  </span>
                </th>
                <th scope="col" className="px-5 py-4 text-center font-semibold text-jp-ink">
                  {PLANS.profit_intelligence_pro.name}
                  <span className="mt-0.5 block text-xs font-normal text-jp-muted">
                    {PLANS.profit_intelligence_pro.priceLabel}/mo
                  </span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-jp-line">
              {COMPARISON.map((row) => (
                <tr key={row.label}>
                  <th scope="row" className="px-5 py-3.5 text-left font-normal text-jp-slate">
                    {row.label}
                  </th>
                  <td className="px-5 py-3.5 text-center text-jp-ink">{row.standard}</td>
                  <td className="px-5 py-3.5 text-center text-jp-ink">{row.pro}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ── Why no cheap tier ───────────────────────────────────────── */}
      <Section>
        <div className="mx-auto max-w-3xl">
          <SectionHeading
            eyebrow="Why there's no cheap plan"
            title="A stripped-down tier would defeat the point"
            align="center"
          />
          <div className="space-y-4 text-[15px] leading-relaxed text-jp-slate">
            <p>
              It would be easy to sell a $49 plan that shows you a table of jobs and leaves you to
              work out what it means. We don&rsquo;t, because that&rsquo;s the part you can already
              get out of QuickBooks with enough effort, and it isn&rsquo;t what actually changes a
              decision.
            </p>
            <p>
              The value of JobProfitAI is in identifying a margin problem early enough to do
              something about it. A single job running 15% over on a $80,000 contract is $12,000. If
              the product does its job even once a year, the arithmetic isn&rsquo;t close.
            </p>
            <p>
              So instead of a cheap tier, there&rsquo;s a genuinely free trial: 14 days, full
              access, no credit card. Connect QuickBooks and judge it on your own numbers before you
              pay anything.
            </p>
          </div>
        </div>
      </Section>

      <Section tone="surface">
        <SectionHeading eyebrow="Questions" title="Pricing questions" align="center" />
        <div className="mx-auto max-w-3xl">
          <Faq items={FAQ_ITEMS} />
        </div>
        <div className="mt-10 text-center">
          <ButtonLink href="/contact" variant="secondary">
            Ask us something else
          </ButtonLink>
        </div>
      </Section>

      <FinalCta
        title="See it on your own numbers first."
        body="Connect QuickBooks and find out which jobs are actually making you money. No card required."
      />
    </>
  );
}
