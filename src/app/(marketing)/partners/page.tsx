import type { Metadata } from "next";
import Link from "next/link";
import {
  ButtonLink,
  Card,
  Eyebrow,
  Faq,
  Section,
  SectionHeading,
  StepCard,
} from "@/components/marketing/ui";
import { PARTNER_TIERS, PARTNER_COMMISSION_MONTHS, PLANS } from "@/lib/plans";

export const metadata: Metadata = {
  title: "Partner Program for Accountants & Bookkeepers",
  description:
    "Earn 20-30% recurring commission for 12 months on every contractor client you refer to JobProfitAI. Built for accountants, bookkeepers, fractional CFOs and QuickBooks ProAdvisors.",
  alternates: { canonical: "/partners" },
  openGraph: {
    title: "JobProfitAI Partner Program",
    description:
      "Recurring commission for accountants and bookkeepers serving contractor clients.",
    url: "/partners",
  },
};

/** Commission on one client at a given rate, for the example table. */
function monthly(priceCents: number, rateBps: number): string {
  return ((priceCents * rateBps) / 10_000 / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });
}

const FAQ_ITEMS = [
  {
    q: "Does referring a client give me access to their financial data?",
    a: (
      <>
        No, and this is deliberate, not an oversight. Being a referral partner grants you no
        access whatsoever to a contractor&rsquo;s QuickBooks data, jobs or profitability. Your
        partner dashboard shows counts and commission amounts only. If a client wants you to see
        their numbers, they have to grant that explicitly through account access controls. A
        referral link is not consent.
      </>
    ),
  },
  {
    q: "When does commission start?",
    a: (
      <>
        Commission accrues from your client&rsquo;s first successfully paid invoice, and continues
        for their first {PARTNER_COMMISSION_MONTHS} paid subscription months. Nothing accrues while
        they&rsquo;re on their free trial, because no money has changed hands.
      </>
    ),
  },
  {
    q: "How is the commission rate decided?",
    a: (
      <>
        By how many referred clients are currently paying. Your rate is applied at the moment each
        invoice is paid and then fixed for that commission. Moving up a tier raises the rate on
        invoices from that point forward. It doesn&rsquo;t retroactively re-price commissions
        you&rsquo;ve already earned.
      </>
    ),
  },
  {
    q: "What about refunds and failed payments?",
    a: (
      <>
        Commission is only earned on subscription revenue that&rsquo;s actually collected and kept.
        Failed payments earn nothing, sales tax is excluded from the calculation, and if a payment
        is refunded or charged back the commission for that invoice is reversed, and that
        month doesn&rsquo;t count against the client&rsquo;s {PARTNER_COMMISSION_MONTHS}-month
        window either.
      </>
    ),
  },
  {
    q: "How and when do I get paid?",
    a: (
      <>
        Honestly: commissions are tracked automatically in a ledger you can see at any time, and
        paid out by our team. There is no automated payout system yet, that requires
        connected-account onboarding, identity verification and tax reporting that we haven&rsquo;t
        built, and we&rsquo;d rather say so than imply money moves on its own. You&rsquo;ll see
        every commission as it&rsquo;s earned, and a confirmation when a payout is recorded.
      </>
    ),
  },
  {
    q: "Do my clients get a discount?",
    a: (
      <>
        Your clients get the same 14-day free trial as anyone else, with no credit card required.
        Pricing is the same published {PLANS.profit_intelligence.priceLabel} and{" "}
        {PLANS.profit_intelligence_pro.priceLabel} per month. We don&rsquo;t discount, which
        is part of what makes the commission worth having.
      </>
    ),
  },
  {
    q: "Is there a cost to join?",
    a: (
      <>
        No. Applying is free, and at around 3 active paying clients your firm earns a complimentary
        JobProfitAI account of its own.
      </>
    ),
  },
];

export default function PartnersPage() {
  return (
    <>
      <Section className="!pb-10">
        <div className="mx-auto max-w-3xl text-center">
          <Eyebrow>Partner Program</Eyebrow>
          <h1 className="text-4xl font-bold leading-tight tracking-tight text-jp-ink sm:text-5xl">
            Help your contractor clients understand their profitability.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-jp-slate">
            You already close their books. JobProfitAI turns that same data into the job-level
            profitability conversation they keep asking you for, without you building a
            spreadsheet for every client. Refer them, and earn recurring commission.
          </p>
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <ButtonLink href="/signup?partner=1" size="lg" className="w-full sm:w-auto">
              Apply to the Partner Program
            </ButtonLink>
            <ButtonLink href="/contact" size="lg" variant="secondary" className="w-full sm:w-auto">
              Ask a question first
            </ButtonLink>
          </div>
          <p className="mt-5 text-sm text-jp-muted">
            Free to join &middot; Applications reviewed by a person
          </p>
        </div>
      </Section>

      {/* ── Commission structure ────────────────────────────────────── */}
      <Section tone="surface">
        <SectionHeading
          eyebrow="Commission"
          title="20% to 30% of subscription revenue, for 12 months per client"
          intro="Free months don't scale for a firm bringing in ten, twenty or fifty contractors. A recurring percentage does, so accountants earn on a different model from individual customer referrals."
          align="center"
        />

        <div className="grid gap-6 sm:grid-cols-3">
          {[...PARTNER_TIERS].reverse().map((tier) => (
            <Card key={tier.key} className="text-center">
              <p className="text-sm font-medium text-jp-muted">{tier.label}</p>
              <p className="mt-3 text-4xl font-bold tracking-tight text-jp-ink">{tier.ratePct}%</p>
              <p className="mt-2 text-sm text-jp-slate">of subscription revenue</p>
            </Card>
          ))}
        </div>

        <div className="mt-10 overflow-x-auto rounded-xl border border-jp-line bg-white">
          <table className="w-full min-w-[520px] text-left text-sm">
            <caption className="border-b border-jp-line px-5 py-3 text-left text-sm font-semibold text-jp-ink">
              What one client is worth per month, by tier
            </caption>
            <thead>
              <tr className="border-b border-jp-line bg-jp-surface text-xs uppercase tracking-wide text-jp-muted">
                <th scope="col" className="px-5 py-3 font-semibold">Client plan</th>
                {[...PARTNER_TIERS].reverse().map((tier) => (
                  <th key={tier.key} scope="col" className="px-5 py-3 text-center font-semibold">
                    {tier.ratePct}%
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-jp-line">
              {[PLANS.profit_intelligence, PLANS.profit_intelligence_pro].map((plan) => (
                <tr key={plan.id}>
                  <th scope="row" className="px-5 py-3.5 text-left font-normal text-jp-slate">
                    {plan.name}{" "}
                    <span className="text-jp-muted">({plan.priceLabel}/mo)</span>
                  </th>
                  {[...PARTNER_TIERS].reverse().map((tier) => (
                    <td
                      key={tier.key}
                      className="px-5 py-3.5 text-center font-semibold tabular-nums text-jp-ink"
                    >
                      {monthly(plan.priceCents, tier.rateBps)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-5 max-w-3xl text-sm leading-relaxed text-jp-muted">
          Commission applies to qualifying subscription revenue for each client&rsquo;s first{" "}
          {PARTNER_COMMISSION_MONTHS} successfully paid months. Sales tax is excluded. Failed
          payments earn nothing, and refunded or disputed payments are reversed. A firm with roughly
          20 paying clients sits in the 25% tier.
        </p>
      </Section>

      {/* ── How it works ────────────────────────────────────────────── */}
      <Section>
        <SectionHeading eyebrow="How it works" title="Four steps" align="center" />
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <StepCard
            number={1}
            title="Apply"
            body="Create a JobProfitAI account and submit a short application for your firm. A person reviews it."
          />
          <StepCard
            number={2}
            title="Get your link"
            body="On approval you get a unique referral link and a partner dashboard showing signups, conversions and commissions."
          />
          <StepCard
            number={3}
            title="Refer clients"
            body="Anyone signing up through your link starts a 14-day free trial with no credit card, attributed to your firm automatically."
          />
          <StepCard
            number={4}
            title="Earn recurring commission"
            body="When a client subscribes, commission accrues on every paid invoice for their first 12 months and appears in your ledger."
          />
        </div>
      </Section>

      {/* ── Privacy guarantee ──────────────────────────────────────── */}
      <Section tone="surface">
        <Card className="mx-auto max-w-3xl border-jp-blue/25">
          <h2 className="text-xl font-bold text-jp-ink">
            Referring a client is not the same as accessing their books
          </h2>
          <div className="mt-4 space-y-3 text-[15px] leading-relaxed text-jp-slate">
            <p>
              This is worth being explicit about, because plenty of referral programs are vague on
              it. Partner status in JobProfitAI grants you a referral code and a commission ledger.
              It grants you no visibility into any client&rsquo;s QuickBooks data, jobs, margins or
              reports, not even the name of the business behind a conversion.
            </p>
            <p>
              If a contractor wants you working inside their numbers with them, they invite you
              deliberately through their own account. That&rsquo;s their decision to make, every
              time.
            </p>
          </div>
        </Card>
      </Section>

      <Section>
        <SectionHeading eyebrow="Questions" title="Partner Program FAQ" align="center" />
        <div className="mx-auto max-w-3xl">
          <Faq items={FAQ_ITEMS} />
        </div>
      </Section>

      <Section tone="ink">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="text-3xl font-bold leading-tight tracking-tight text-white sm:text-4xl">
            Your clients are already asking which jobs made money.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-slate-300">
            Give them a real answer, and earn recurring revenue for your firm while you do it.
          </p>
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <ButtonLink href="/signup?partner=1" size="lg" className="w-full sm:w-auto">
              Apply to the Partner Program
            </ButtonLink>
            <ButtonLink
              href="/how-it-works"
              size="lg"
              variant="secondary"
              className="w-full border-white/25 bg-transparent text-white hover:border-white hover:text-white sm:w-auto"
            >
              See how the product works
            </ButtonLink>
          </div>
          <p className="mt-6 text-sm text-slate-400">
            Already have an account?{" "}
            <Link href="/dashboard/partner" className="font-medium text-white hover:underline">
              Apply from your dashboard
            </Link>
            .
          </p>
        </div>
      </Section>
    </>
  );
}
