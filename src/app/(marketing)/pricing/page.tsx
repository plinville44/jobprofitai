import type { Metadata } from "next";
import Link from "next/link";
import { ButtonLink, Eyebrow, Faq, FinalCta, Section, SectionHeading } from "@/components/marketing/ui";
import PricingCards from "@/components/marketing/PricingCards";
import PlanGuide from "@/components/marketing/PlanGuide";
import FitCheck from "@/components/marketing/FitCheck";
import { PLANS } from "@/lib/plans";
import { OG_IMAGE } from "@/lib/siteMeta";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "JobProfitAI pricing: Profit Intelligence at $149/month, Profit Intelligence Pro at $299/month, and Firm for bookkeepers at $79 per client company. 14-day free trial, no credit card required, cancel anytime.",
  alternates: { canonical: "/pricing" },
  openGraph: {
    images: [OG_IMAGE],
    title: "JobProfitAI Pricing: $149 and $299 a month, and $79 per company for bookkeepers",
    description:
      "Two contractor plans and a Firm plan for bookkeepers, all including AI profit insights and recommendations. 14 days free, no credit card required.",
    url: "/pricing",
  },
};

const FAQ_ITEMS = [
  {
    q: "QuickBooks Plus already shows project profitability. Why pay for this?",
    a: (
      <>
        <span className="block">
          The difference is that QuickBooks reports and JobProfitAI tells you where to look. Plus
          shows income, cost and margin for a job you go and open. It doesn&rsquo;t compare that
          margin to a target you set, flag which jobs are drifting below it, tell you a type of work
          consistently runs over estimate, forecast where an in-progress job lands, build a WIP
          report of what&rsquo;s over and under billed, email you after the nightly sync when a
          job&rsquo;s costs go more than 10% over its estimate, or send you a weekly brief of what
          changed.
        </span>
        <span className="mt-3 block">
          It also won&rsquo;t tell you that six of your jobs have no estimate on file and four have
          revenue with no costs assigned to them. That is usually the reason the reports looked fine
          and the bank balance didn&rsquo;t.
        </span>
        <span className="mt-3 block">
          QuickBooks Online Advanced has project tools that cover some of this. JobProfitAI is built
          for contractors on Plus who want it without moving to Advanced.
        </span>
      </>
    ),
  },
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
        Yes. Every plan is month to month. You cancel yourself from your billing settings through
        Stripe&rsquo;s billing portal, no contract, no notice period, no phone call.
      </>
    ),
  },
  {
    q: "Can I switch between plans?",
    a: (
      <>
        Between Profit Intelligence and Pro, yes, in either direction, from your billing
        settings, and Stripe prorates the change automatically. To move to or from the Firm plan,
        email support@jobprofitai.com and we&rsquo;ll switch it for you. If you move down to a plan that covers fewer jobs or companies than
        you&rsquo;re currently using, nothing is deleted. Your Billing page shows your usage
        against the new plan&rsquo;s limits, and you can&rsquo;t connect another QuickBooks company
        while you&rsquo;re over the company limit.
      </>
    ),
  },
  {
    q: "What counts as an “active job”?",
    a: (
      <>
        A job you haven&rsquo;t marked completed yet: a QuickBooks Project or sub-customer, a
        customer if you make one customer per job, or a Class if each job is a class.
        QuickBooks doesn&rsquo;t expose project status through its API, so you mark jobs completed
        inside JobProfitAI, one at a time, in bulk from the jobs list, or all at once for jobs with
        no activity in 90 days. Completed jobs stay in your history and your trend analysis; they
        don&rsquo;t count against the limit. If you have more than{" "}
        {PLANS.profit_intelligence.limits.maxActiveJobs} open on {PLANS.profit_intelligence.name},
        we&rsquo;ll ask you to move to Pro; nothing stops working.
      </>
    ),
  },
  {
    q: "Do you offer annual billing or an enterprise plan?",
    a: (
      <>
        Not at launch. Every plan is monthly. Bookkeepers and accountants with contractor clients
        have the Firm plan, priced per client company. If you need something the plans don&rsquo;t
        cover,{" "}
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
  { label: "Team logins", standard: "3", pro: "10" },
  { label: "Jobs from Projects, customers or Classes", standard: "Included", pro: "Included" },
  { label: "Profit Opportunity Feed, ranked by dollars", standard: "Included", pro: "Included" },
  { label: "Pricing gaps by job type, customer, size & part of the job", standard: "Included", pro: "Included" },
  { label: "Estimate Check on pending QuickBooks estimates", standard: "Included", pro: "Included" },
  { label: "Estimates costed from their quantities", standard: "Included", pro: "Included" },
  { label: "Track pricing changes and their results", standard: "Included", pro: "Included" },
  { label: "Your own job types, with suggestions", standard: "Included", pro: "Included" },
  { label: "Job profitability dashboard", standard: "Included", pro: "Included" },
  { label: "Revenue, cost, gross profit & margin by job", standard: "Included", pro: "Included" },
  { label: "Cost breakdown by category", standard: "Included", pro: "Included" },
  { label: "Labor at the cost rate on each time entry, plus any labor burden", standard: "Included", pro: "Included" },
  { label: "Estimate vs. actual comparison", standard: "Included", pro: "Included" },
  { label: "Margin leak & cost-overrun detection", standard: "Included", pro: "Included" },
  { label: "Historical profitability trends", standard: "Included", pro: "Included" },
  { label: "Margin by job type, month by month", standard: "Included", pro: "Included" },
  { label: "AI advisor notes on your opportunities", standard: "Included", pro: "Included" },
  { label: "WIP report (over and under billing)", standard: "Included", pro: "Included" },
  { label: "Bank-ready WIP schedule, print or PDF", standard: "Included", pro: "Included" },
  { label: "Money you're owed: unbilled work, possible change orders, unpaid invoices", standard: "Included", pro: "Included" },
  { label: "Data Health checks", standard: "Included", pro: "Included" },
  { label: "Weekly Profit Brief", standard: "Included", pro: "Included" },
  { label: "Forecast at completion on open jobs", standard: "Not included", pro: "Included" },
  { label: "Open jobs heading below target, in your opportunities", standard: "Not included", pro: "Included" },
  { label: "Benchmarking each job against similar finished jobs", standard: "Not included", pro: "Included" },
  { label: "Support", standard: "Email support", pro: "Priority support" },
];

export default function PricingPage() {
  return (
    <>
      <Section className="!pb-8">
        <div className="mx-auto max-w-3xl text-center">
          <Eyebrow>Pricing</Eyebrow>
          <h1 className="text-4xl font-bold leading-tight tracking-tight text-jp-ink sm:text-5xl">
            Priced against the profit it finds.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-jp-slate">
            Every plan puts a dollar figure on what to change: the job type you&rsquo;re underpricing,
            the thin part of your price, the estimate to fix before it goes out. Fix one of those and
            it can pay for itself.
          </p>
          <p className="mt-5 text-sm text-jp-muted">
            14-day free trial &middot; No credit card required &middot; Cancel anytime
          </p>
        </div>
      </Section>

      <Section className="!pt-4">
        <PricingCards />
      </Section>

      <Section tone="surface" id="which-plan">
        <SectionHeading
          eyebrow="Which plan fits"
          title="Pick by how many jobs you have open at once"
          intro="Both plans include everything that finds the money. The difference is scale, and forecasts for jobs in progress."
          align="center"
        />
        <PlanGuide />
      </Section>

      <Section id="firm">
        <div className="mx-auto max-w-5xl rounded-2xl border border-jp-line bg-white p-7 sm:p-9">
          <div className="grid gap-8 lg:grid-cols-[1.3fr_1fr]">
            <div>
              <p className="text-sm font-semibold uppercase tracking-wide text-jp-blue">For bookkeepers and accountants</p>
              <h2 className="mt-2 text-2xl font-bold tracking-tight text-jp-ink sm:text-3xl">
                {PLANS.firm.name}: every client&rsquo;s job profit in one login
              </h2>
              <p className="mt-3 text-[15px] leading-relaxed text-jp-slate">
                Connect each contractor you keep books for. See all of them on one portfolio page, open any one for
                its jobs, estimates, WIP and money owed, and give each client a view-only login to their own company.
              </p>
              <p className="mt-3 text-[15px] leading-relaxed text-jp-slate">
                Keeping books for 2 or 3 contractors? {PLANS.profit_intelligence_pro.name} covers up to{" "}
                {PLANS.profit_intelligence_pro.limits.maxConnections} companies for{" "}
                {PLANS.profit_intelligence_pro.priceLabel} a month, with the same portfolio page but no client logins.{" "}
                {PLANS.firm.name} starts at {PLANS.firm.perCompany!.minCompanies} companies.
              </p>
              <ul className="mt-5 space-y-2.5 text-[15px]">
                {PLANS.firm.marketingFeatures.map((f) => (
                  <li key={f} className="flex gap-2.5">
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-jp-green" aria-hidden="true" />
                    <span className="leading-relaxed text-jp-slate">{f}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex flex-col justify-center rounded-xl bg-jp-surface p-6">
              <p className="text-4xl font-bold tracking-tight text-jp-ink">
                {PLANS.firm.priceLabel}
                <span className="text-base font-normal text-jp-muted"> per company/month</span>
              </p>
              <p className="mt-2 text-sm text-jp-slate">
                {PLANS.firm.perCompany!.minCompanies} company minimum, so{" "}
                {`$${(PLANS.firm.priceCents * PLANS.firm.perCompany!.minCompanies) / 100}`} a month at least. The bill
                follows the companies you have connected, prorated.
              </p>
              <ButtonLink href="/signup" className="mt-5 w-full">
                Start Free Trial
              </ButtonLink>
              <p className="mt-3 text-center text-xs text-jp-muted">
                The 14-day trial covers {PLANS.profit_intelligence_pro.limits.maxConnections} companies, client logins
                included. Choose Firm to connect more.
              </p>
              <ButtonLink href="/contact" variant="secondary" className="mt-4 w-full">
                Talk to us
              </ButtonLink>
            </div>
          </div>
        </div>
      </Section>

      <Section id="fit-check" tone="surface">
        <SectionHeading
          eyebrow="30-second check"
          title="Will this work with my QuickBooks?"
          intro="Six quick questions and a straight answer, with the plan that fits."
          align="center"
        />
        <FitCheck />
      </Section>

      {/* ── Detailed comparison ─────────────────────────────────────── */}
      <Section>
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
      <Section tone="surface">
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
            <p>
              The Firm plan&rsquo;s {PLANS.firm.priceLabel} is per client company, with a{" "}
              {PLANS.firm.perCompany!.minCompanies}-company minimum. It&rsquo;s for bookkeepers
              covering several contractors, not a cheaper way in for one.
            </p>
          </div>
        </div>
      </Section>

      <Section>
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
