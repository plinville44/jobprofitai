import type { Metadata } from "next";
import { ButtonLink, FinalCta, Section, SectionHeading } from "@/components/marketing/ui";
import {
  DashboardPreview,
  EstimateCheckPreview,
  JobListPreview,
  OpportunityFeedPreview,
  PricingBreakdownPreview,
  TrackedChangePreview,
  WeeklyBriefPreview,
} from "@/components/marketing/ProductPreview";

/**
 * /demo: the product with example data, no signup, no QuickBooks connection.
 *
 * The funnel has no sales calls, so this page does the "let me show you"
 * part of one. Everything here is static and rendered from the same labelled
 * example company as the home page previews; nothing reads a database, and
 * nothing on it can be edited. Every frame carries the "Example data" badge,
 * and the banner says so in words too, because presenting invented figures
 * as a customer's would be a fabricated case study.
 */

export const metadata: Metadata = {
  title: "See JobProfitAI with sample data",
  description:
    "Look around JobProfitAI using an example contractor's jobs: what to change and what it's worth, the Estimate Check, results tracking, margins by job and the Weekly Profit Brief. No signup needed.",
  alternates: { canonical: "/demo" },
  openGraph: {
    title: "See JobProfitAI with sample data",
    description: "An example contractor's job profitability, no signup needed.",
    url: "/demo",
  },
};

function SampleBanner() {
  return (
    <div className="rounded-xl border border-jp-line bg-jp-surface px-5 py-4 sm:flex sm:items-center sm:justify-between sm:gap-6">
      <p className="text-sm leading-relaxed text-jp-slate">
        <span className="font-semibold text-jp-ink">This is sample data from an example company.</span>{" "}
        Start your free trial to see your own jobs from QuickBooks Online. No credit card required.
      </p>
      <ButtonLink href="/signup" className="mt-3 w-full shrink-0 sm:mt-0 sm:w-auto">
        Start Your 14-Day Free Trial
      </ButtonLink>
    </div>
  );
}

export default function DemoPage() {
  return (
    <>
      <Section className="!pb-8">
        <SectionHeading
          eyebrow="Sample data demo"
          title="See what JobProfitAI shows you, before you connect anything"
          intro="This is an invented contractor, Example Builders, with a year of kitchens, bathrooms, roofs and service calls. The opportunities, estimate check and tracked change below are worked out by the real product from their made-up numbers. The dashboard, job list and weekly email are illustrations of the same screens you get once your QuickBooks Online company is connected."
        />
        <SampleBanner />
      </Section>

      <Section className="!pt-0 !pb-10">
        <h2 className="text-xl font-bold text-jp-ink">1. What to change, and what it&rsquo;s worth</h2>
        <p className="mt-2 max-w-3xl text-jp-slate">
          The Profit Opportunity Feed leads with four numbers, then lists what to change, biggest
          first: an estimate to fix before it goes out, a job type priced below target, a customer
          whose work doesn&rsquo;t pay. Each says why, what to do, and how sure it is.
        </p>
        <div className="mt-6">
          <OpportunityFeedPreview items={4} />
        </div>
      </Section>

      <Section className="!pt-0 !pb-10">
        <h2 className="text-xl font-bold text-jp-ink">2. Which part of the price is thin</h2>
        <p className="mt-2 max-w-3xl text-jp-slate">
          Example Builders&rsquo; estimates split labor, materials and subs, so JobProfitAI can see
          that on kitchens it&rsquo;s the labor: customers paid for it and it cost nearly as much again.
        </p>
        <div className="mt-6">
          <PricingBreakdownPreview />
        </div>
      </Section>

      <Section className="!pt-0 !pb-10">
        <h2 className="text-xl font-bold text-jp-ink">3. The Estimate Check</h2>
        <p className="mt-2 max-w-3xl text-jp-slate">
          A pending kitchen estimate, checked part by part against what their last eight kitchens
          actually cost, before it goes to the customer.
        </p>
        <div className="mt-6">
          <EstimateCheckPreview />
        </div>
      </Section>

      <Section className="!pt-0 !pb-10">
        <h2 className="text-xl font-bold text-jp-ink">4. Did the change work?</h2>
        <p className="mt-2 max-w-3xl text-jp-slate">
          Last October their roofs were finishing at 21%. They raised roofing prices and pressed
          &ldquo;I&rsquo;m making this change.&rdquo; Five roofs set up since then have finished.
        </p>
        <div className="mt-6">
          <TrackedChangePreview />
        </div>
      </Section>

      <Section className="!pt-0 !pb-10">
        <h2 className="text-xl font-bold text-jp-ink">5. Your Profit Dashboard</h2>
        <p className="mt-2 max-w-3xl text-jp-slate">
          The top row totals every job. Needs Your Attention lists the jobs to look at first, how much
          is at stake on each, and how strong the evidence is.
        </p>
        <div className="mt-6">
          <DashboardPreview />
        </div>
      </Section>

      <Section className="!pt-0 !pb-10">
        <h2 className="text-xl font-bold text-jp-ink">6. Every job, with its margin</h2>
        <p className="mt-2 max-w-3xl text-jp-slate">
          Revenue and costs come straight from the invoices, bills and expenses tagged to each
          QuickBooks project. Jobs under your target margin stand out.
        </p>
        <div className="mt-6">
          <JobListPreview />
        </div>
      </Section>

      <Section className="!pt-0 !pb-10">
        <h2 className="text-xl font-bold text-jp-ink">7. The Weekly Profit Brief, every week</h2>
        <p className="mt-2 max-w-3xl text-jp-slate">
          The money first, then what changed since last week, in your inbox on the day and time you
          choose. You don&rsquo;t have to log in to get the value.
        </p>
        <div className="mt-6">
          <WeeklyBriefPreview />
        </div>
      </Section>

      <Section className="!pt-0">
        <div className="mt-2">
          <SampleBanner />
        </div>
      </Section>

      <FinalCta
        title="Now see it with your own jobs."
        body="Connect QuickBooks Online in about two minutes. Read-only, and nothing in your books changes."
      />
    </>
  );
}
