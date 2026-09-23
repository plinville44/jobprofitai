import type { Metadata } from "next";
import { ButtonLink, FinalCta, Section, SectionHeading } from "@/components/marketing/ui";
import {
  DashboardPreview,
  InsightPreview,
  JobListPreview,
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
    "Look around JobProfitAI using an example contractor's jobs: margins by job, jobs that need attention, the Weekly Profit Brief and Profit Intelligence. No signup needed.",
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
          intro="This is an example contractor with seven jobs. It is the same dashboard, job list and weekly email you get once your QuickBooks Online company is connected, just with made-up numbers."
        />
        <SampleBanner />
      </Section>

      <Section className="!pt-0 !pb-10">
        <h2 className="text-xl font-bold text-jp-ink">1. Your Profit Dashboard</h2>
        <p className="mt-2 max-w-3xl text-jp-slate">
          The top row totals every job. Needs Your Attention lists the jobs to look at first, how much
          is at stake on each, and how strong the evidence is.
        </p>
        <div className="mt-6">
          <DashboardPreview />
        </div>
      </Section>

      <Section className="!pt-0 !pb-10">
        <h2 className="text-xl font-bold text-jp-ink">2. Every job, with its margin</h2>
        <p className="mt-2 max-w-3xl text-jp-slate">
          Revenue and costs come straight from the invoices, bills and expenses tagged to each
          QuickBooks project. Jobs under your target margin stand out.
        </p>
        <div className="mt-6">
          <JobListPreview />
        </div>
      </Section>

      <Section className="!pt-0 !pb-10">
        <h2 className="text-xl font-bold text-jp-ink">3. The Weekly Profit Brief, every week</h2>
        <p className="mt-2 max-w-3xl text-jp-slate">
          What changed since last week, and the one job to look at, in your inbox on the day and time you choose. You don&rsquo;t have
          to log in to get the value.
        </p>
        <div className="mt-6">
          <WeeklyBriefPreview />
        </div>
      </Section>

      <Section className="!pt-0">
        <h2 className="text-xl font-bold text-jp-ink">4. Patterns across your finished jobs</h2>
        <p className="mt-2 max-w-3xl text-jp-slate">
          Once you have completed jobs, Profit Intelligence compares them and points out what keeps
          costing you, with the jobs behind every finding.
        </p>
        <div className="mt-6">
          <InsightPreview />
        </div>
        <div className="mt-10">
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
