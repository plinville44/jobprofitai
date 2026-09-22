import type { Metadata } from "next";
import Link from "next/link";
import {
  ButtonLink,
  Card,
  Eyebrow,
  FinalCta,
  Section,
  SectionHeading,
} from "@/components/marketing/ui";
import {
  DashboardPreview,
  InsightPreview,
  WeeklyBriefPreview,
} from "@/components/marketing/ProductPreview";

export const metadata: Metadata = {
  title: "How It Works",
  description:
    "How JobProfitAI works: connect QuickBooks Online, organize your job financials, see which jobs make and lose money, catch margin leaks early, and get a Weekly Profit Brief.",
  alternates: { canonical: "/how-it-works" },
  openGraph: {
    title: "How JobProfitAI Works",
    description:
      "From connecting QuickBooks to knowing which jobs are actually profitable, in six steps.",
    url: "/how-it-works",
  },
};

function Step({
  number,
  title,
  children,
  aside,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <div className="border-t border-jp-line pt-10 first:border-t-0 first:pt-0">
      <div className="grid gap-8 lg:grid-cols-[1fr_1.1fr] lg:gap-14">
        <div>
          <div className="mb-4 flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-jp-blue text-sm font-bold text-white">
              {number}
            </span>
            <span className="text-xs font-semibold uppercase tracking-[0.12em] text-jp-muted">
              Step {number}
            </span>
          </div>
          <h2 className="text-2xl font-bold tracking-tight text-jp-ink sm:text-[1.7rem]">{title}</h2>
          <div className="mt-4 space-y-4 text-[15px] leading-relaxed text-jp-slate">{children}</div>
        </div>
        {aside ? <div className="lg:pt-2">{aside}</div> : null}
      </div>
    </div>
  );
}

export default function HowItWorksPage() {
  return (
    <>
      <Section className="!pb-10">
        <div className="mx-auto max-w-3xl text-center">
          <Eyebrow>How it works</Eyebrow>
          <h1 className="text-4xl font-bold leading-tight tracking-tight text-jp-ink sm:text-5xl">
            From QuickBooks data to better profit decisions.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-jp-slate">
            QuickBooks is where your accounting data lives. JobProfitAI is the intelligence layer on
            top of it. Here&rsquo;s exactly what happens, start to finish.
          </p>
        </div>
      </Section>

      <Section className="!pt-4">
        <div className="space-y-14">
          <Step
            number={1}
            title="Connect QuickBooks"
            aside={
              <Card>
                <h3 className="text-sm font-semibold text-jp-ink">What connecting actually does</h3>
                <ul className="mt-3 space-y-2.5 text-sm leading-relaxed text-jp-slate">
                  <li className="flex gap-2.5">
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-jp-green" aria-hidden="true" />
                    You log in on Intuit&rsquo;s own website. Your QuickBooks password is never
                    entered into JobProfitAI.
                  </li>
                  <li className="flex gap-2.5">
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-jp-green" aria-hidden="true" />
                    JobProfitAI only ever reads from QuickBooks. It does not create, edit or delete
                    anything in your books.
                  </li>
                  <li className="flex gap-2.5">
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-jp-green" aria-hidden="true" />
                    You can disconnect at any time from Settings, which revokes the connection with
                    Intuit.
                  </li>
                </ul>
                <p className="mt-4 text-xs leading-relaxed text-jp-muted">
                  Full detail on the{" "}
                  <Link href="/security" className="font-medium text-jp-blue hover:underline">
                    security page
                  </Link>
                  .
                </p>
              </Card>
            }
          >
            <p>
              Click &ldquo;Connect to QuickBooks&rdquo; and you&rsquo;re sent to Intuit&rsquo;s
              official authorization screen, where you log in the way you always do and approve
              access for JobProfitAI. It takes about two minutes.
            </p>
            <p>
              This uses Intuit&rsquo;s standard OAuth connection, the same mechanism every
              QuickBooks app uses. Nothing about your QuickBooks credentials passes through our
              servers; we receive an access token, which we encrypt before storing.
            </p>
          </Step>

          <Step
            number={2}
            title="JobProfitAI organizes the financial information"
          >
            <p>
              JobProfitAI reads QuickBooks <strong>Projects</strong> (sub-customers) and pulls
              together everything attached to each one. Invoices, bills, expenses, purchases, time
              activities and estimates. Contractors who track job cost by Class instead are not
              supported yet; that is on the roadmap rather than in the product, and it is worth
              checking before you sign up.
            </p>
            <p>
              Costs are grouped into categories you&rsquo;d actually recognize: labor, materials,
              subcontractors, equipment and overhead. Where a cost was tagged to a customer rather
              than to the specific job, JobProfitAI attributes it only when it can do so
              defensibly, and flags that it made that judgment rather than hiding it.
            </p>
            <p>
              Optionally, you set a company-wide target margin and an overhead allocation method.
              Both are yours to configure; neither is guessed at.
            </p>
          </Step>

          <Step
            number={3}
            title="See what's making or losing money"
            aside={<DashboardPreview />}
          >
            <p>
              Your Profit Dashboard shows revenue, cost, gross profit and margin for every job, plus
              company-wide totals: average job margin, how many jobs are below your target, and the
              dollar value of profit currently at risk.
            </p>
            <p>
              Open any job to see the full cost breakdown by category, the estimate-versus-actual
              comparison, and a profit leakage view showing where expected profit turned into actual
              profit.
            </p>
          </Step>

          <Step number={4} title="Find issues before they become bigger">
            <p>
              &ldquo;Needs Your Attention&rdquo; is a deterministic rule set that runs across every
              job: costs running over estimate, margins below target, margin declining across
              recent weekly snapshots, and cost categories that look like outliers compared to
              similar completed jobs.
            </p>
            <p>
              Each finding carries a dollar impact, a severity, and a confidence level. Confidence
              is based on how much data supports the finding, a pattern across six completed jobs
              is treated differently from a sample of one, and rules that need comparison data
              simply don&rsquo;t fire until there&rsquo;s enough of it.
            </p>
            <p>
              There&rsquo;s also a Data Health page that tells you exactly what is missing before
              you trust a number: expenses not tagged to any job, jobs with revenue but no costs
              recorded, time entries QuickBooks gave us with no hourly rate, and jobs with no cost
              estimate entered here. Those gaps change what the numbers can tell you, so
              they&rsquo;re shown rather than papered over.
            </p>
          </Step>

          <Step number={5} title="Get recommendations" aside={<InsightPreview />}>
            <p>
              Profit Intelligence takes the patterns found across your jobs and turns them into
              plain-English findings: what was observed, the evidence behind it, the financial
              impact, and a concrete action worth considering.
            </p>
            <p>
              An important detail about how this is built: the dollar amounts, percentages,
              confidence levels and the list of jobs behind each finding are all calculated by the
              application, and those are the values stored and displayed. The AI writes the
              explanation and the recommendation around them. Every finding names the jobs it came
              from, so you can check any of it against the job pages rather than taking it on
              faith. That&rsquo;s deliberate. Profit decisions shouldn&rsquo;t rest on a number a
              language model produced.
            </p>
          </Step>

          <Step
            number={6}
            title="Get your Weekly Profit Brief"
            aside={<WeeklyBriefPreview />}
          >
            <p>
              Once a week, on the day and hour you choose in your own timezone, JobProfitAI syncs
              the latest data and emails a short brief. It opens with what changed since the last
              one: new costs and billing on each job, margins that moved, jobs that just went over
              their estimate, and jobs you marked completed. That part is calculated, not written
              by AI. A short written summary follows, leading with the job that most needs your
              attention.
            </p>
            <p>
              It goes to as many recipients as you like. You, your project manager, your
              bookkeeper. And if your data is too incomplete that week to say anything reliable
              about profitability, the email says exactly that and lists what&rsquo;s missing,
              instead of writing a confident-sounding summary around gaps.
            </p>
          </Step>
        </div>
      </Section>

      <Section tone="surface">
        <div className="mx-auto max-w-3xl text-center">
          <SectionHeading
            eyebrow="Get started"
            title="Try it on your own jobs"
            intro="14 days of full access. No credit card required. Connect QuickBooks and see what your numbers actually say."
            align="center"
          />
          <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
            <ButtonLink href="/signup" size="lg" className="w-full sm:w-auto">
              Start Your 14-Day Free Trial
            </ButtonLink>
            <ButtonLink href="/pricing" size="lg" variant="secondary" className="w-full sm:w-auto">
              See Pricing
            </ButtonLink>
          </div>
          <p className="mt-5 text-sm text-jp-muted">No credit card required.</p>
        </div>
      </Section>

      <FinalCta />
    </>
  );
}
