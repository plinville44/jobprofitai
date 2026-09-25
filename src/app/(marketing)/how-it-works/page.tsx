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
  EstimateCheckPreview,
  OpportunityFeedPreview,
  TrackedChangePreview,
  WeeklyBriefPreview,
} from "@/components/marketing/ProductPreview";

export const metadata: Metadata = {
  title: "How It Works",
  description:
    "How JobProfitAI works: connect QuickBooks Online, see what to change on your pricing and what it's worth, check estimates before you send them, track the result, and get a Weekly Profit Brief.",
  alternates: { canonical: "/how-it-works" },
  openGraph: {
    title: "How JobProfitAI Works",
    description: "From connecting QuickBooks to knowing what to change, and what it's worth, in eight steps.",
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
            From QuickBooks data to what to change, and what it&rsquo;s worth.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-jp-slate">
            QuickBooks is where your accounting data lives and shows how each job did. JobProfitAI is
            the profit layer on top of it: it finds what to change, puts a dollar figure on it, and
            measures whether the change worked. Here&rsquo;s exactly what happens, start to finish.
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
              JobProfitAI reads QuickBooks <strong>Projects</strong> (sub-customers), or, if you
              make one customer per job, your customers, and pulls together everything attached to
              each one: invoices, sales receipts, credit memos, bills, expenses, vendor credits,
              time entries and estimates. Sales tax is taken out of revenue, refunds and credits
              come off, and labor from timesheets is costed at each person&rsquo;s pay rate, not
              the rate you bill. Contractors who track job cost by Class instead are not supported
              yet; that is on the roadmap rather than in the product, and it is worth checking
              before you sign up.
            </p>
            <p>
              Costs are grouped into categories you&rsquo;d actually recognize: labor, materials,
              subcontractors, equipment and overhead. Where a cost was tagged to a customer rather
              than to the specific job, JobProfitAI attributes it only when it can do so
              defensibly, and flags that it made that judgment rather than hiding it.
            </p>
            <p>
              The lines on your QuickBooks estimates are sorted the same way, by their product or
              service, so JobProfitAI knows how each price was split between labor, materials, subs
              and equipment. If an account or product lands in the wrong category, you move it in
              Settings.
            </p>
            <p>
              You set a target margin, company-wide or per job type, and confirm a job type for each
              job. QuickBooks has no field for job type, so JobProfitAI suggests one from each
              job&rsquo;s name and estimate (and, if you ask, from AI reading the job and customer
              names), and nothing is applied until you accept it. Use the built-in types, rename
              them, or add your own, such as Kitchen remodel or Service call.
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
              profit. One click puts the job&rsquo;s revenue and costs beside QuickBooks&rsquo; own
              Profit and Loss for the same project, and explains any difference.
            </p>
            <p>
              The WIP report shows every open job&rsquo;s contract, cost to date, percent complete
              and whether you&rsquo;re over or under billed, the report banks and bonding companies
              ask for. It exports to a spreadsheet for your accountant.
            </p>
          </Step>

          <Step number={4} title="Find issues before they become bigger">
            <p>
              &ldquo;Needs Your Attention&rdquo; is a deterministic rule set that runs across every
              job: costs running over estimate, finished jobs below your target margin, work done
              but not yet billed, margin declining across recent weekly snapshots, and cost
              categories that look like outliers compared to similar completed jobs. On Pro,
              in-progress jobs are also judged on where they&rsquo;re forecast to finish.
            </p>
            <p>
              JobProfitAI syncs every night, and emails you as soon as an open job goes over its
              estimate or gets well ahead of its billing, instead of waiting for the weekly brief.
            </p>
            <p>
              Each finding carries a dollar impact, a severity, and a confidence level. Confidence
              is based on how much data supports the finding, a pattern across six completed jobs
              is treated differently from a sample of one, and rules that need comparison data
              simply don&rsquo;t fire until there&rsquo;s enough of it.
            </p>
            <p>
              There&rsquo;s also a Data Health page that tells you exactly what is missing before
              you trust a number: job costs (materials, subcontractors, cost of goods) from the
              last year not tagged to any job, jobs with revenue but no costs recorded, time entries
              with no pay rate in QuickBooks, and open jobs with no cost estimate. Those gaps change what the numbers can tell you, so
              they&rsquo;re shown rather than papered over.
            </p>
          </Step>

          <Step number={5} title="See what to change, ranked by dollars" aside={<OpportunityFeedPreview items={2} />}>
            <p>
              The Profit Opportunity Feed compares every job you finished in the last 12 months with
              the ones like it, by job type, customer, job size and part of the job, and lists what
              to change, biggest first. Each opportunity says what the numbers show, why, what to do,
              how sure it is, and which jobs it comes from.
            </p>
            <p>
              The dollar figure is worked out in the open: the price that would have hit your target
              margin on the same costs, minus what the jobs actually sold for. When your estimates
              split the price, it goes further and names the thin part: for example, that customers
              paid for labor on your kitchens and it cost nearly as much again, and how much to add
              to the labor on the next one.
            </p>
            <p>
              Every number is calculated by the application from your data. AI writes advisor notes
              around the opportunities, and never produces or changes a figure. Profit decisions
              shouldn&rsquo;t rest on a number a language model came up with.
            </p>
          </Step>

          <Step number={6} title="Check estimates before they go out" aside={<EstimateCheckPreview />}>
            <p>
              Every pending estimate in QuickBooks is checked against what your finished jobs of the
              same type actually cost for each dollar you charged, over the last two years. When the
              estimate splits labor, materials and subs, each part is checked at its own rate. If the
              price won&rsquo;t reach your target, you see by how much and the price that would, and
              whether QuickBooks has emailed the estimate yet.
            </p>
            <p>
              It needs at least three finished jobs of the type, and it only reads QuickBooks: you
              change the estimate there, and the check updates on the next sync.
            </p>
          </Step>

          <Step number={7} title="Track the change and see the result" aside={<TrackedChangePreview />}>
            <p>
              When you act on a pricing opportunity, press &ldquo;I&rsquo;m making this
              change.&rdquo; JobProfitAI records the margin you started from, then compares the jobs
              you create in QuickBooks from that day on, as they finish. You see the margin before,
              the margin since, and the extra gross profit, on your own jobs.
            </p>
          </Step>

          <Step
            number={8}
            title="Get your Weekly Profit Brief"
            aside={<WeeklyBriefPreview />}
          >
            <p>
              Once a week, on the day and hour you choose in your own timezone, JobProfitAI syncs
              the latest data and emails a short brief. It leads with the money: new margin risk on
              your open jobs since the last brief, estimates priced below target, and your biggest
              opportunities; when there&rsquo;s $500 or more of new risk, or an estimate to fix, the
              subject line says so. Then what changed on each job:
              new costs and billing, margins that moved, jobs that went over their estimate. Those
              parts are calculated, not written by AI. A short written summary follows.
            </p>
            <p>
              It goes to up to 10 people: you, your project manager, your bookkeeper. Each can
              unsubscribe with one click. And if your data is too incomplete that week to say anything reliable
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
