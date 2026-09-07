import type { Metadata } from "next";
import Link from "next/link";
import {
  ButtonLink,
  Card,
  Eyebrow,
  Faq,
  FinalCta,
  Section,
  SectionHeading,
  StepCard,
  ValueCard,
} from "@/components/marketing/ui";
import {
  DashboardPreview,
  InsightPreview,
  WeeklyBriefPreview,
} from "@/components/marketing/ProductPreview";
import PricingCards from "@/components/marketing/PricingCards";

export const metadata: Metadata = {
  title: "JobProfitAI: Profit Intelligence for QuickBooks",
  description:
    "Know which jobs are making you money, and which ones are costing you. JobProfitAI turns your QuickBooks data into job profitability, margin insights, profit alerts and clear next actions for contractors.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "JobProfitAI: Profit Intelligence for QuickBooks",
    description:
      "Know which jobs are making you money, and which ones are costing you.",
    url: "/",
  },
};

const QUESTIONS = [
  "Which jobs are actually profitable?",
  "Which jobs are below the margin we expected?",
  "Where did costs run over?",
  "Are margins improving or getting worse?",
  "What needs attention right now?",
  "What should I change on future jobs?",
];

const FAQ_ITEMS = [
  {
    q: "Does JobProfitAI replace QuickBooks?",
    a: (
      <>
        No. QuickBooks stays exactly where it is and keeps doing what it does. JobProfitAI is an
        intelligence layer on top of it. It reads your job, revenue and cost data and turns it into
        profitability you can actually act on. You keep working in QuickBooks the same way.
      </>
    ),
  },
  {
    q: "How does JobProfitAI connect to QuickBooks?",
    a: (
      <>
        Through Intuit&rsquo;s official OAuth connection. You click &ldquo;Connect to
        QuickBooks,&rdquo; log in on Intuit&rsquo;s own website the way you normally do, and approve
        access. Your QuickBooks username and password are never entered into JobProfitAI and never
        pass through our servers. You can disconnect at any time from Settings.{" "}
        <Link href="/security" className="font-medium text-jp-blue hover:underline">
          More on how this works
        </Link>
        .
      </>
    ),
  },
  {
    q: "Do I need to change the way I use QuickBooks?",
    a: (
      <>
        No. JobProfitAI reads whichever way you already track job cost, whether that&rsquo;s
        QuickBooks Projects or Classes, and it works out which one you use automatically. You will get more out of it if your
        costs are consistently tagged to jobs, and the built-in Data Health page tells you exactly
        where that&rsquo;s incomplete rather than quietly guessing.
      </>
    ),
  },
  {
    q: "Is there a free trial?",
    a: <>Yes, 14 days, with full access to everything.</>,
  },
  {
    q: "Is a credit card required?",
    a: (
      <>
        No. The trial needs no card and no payment details of any kind. You only enter payment
        information if and when you decide to choose a plan.
      </>
    ),
  },
  {
    q: "What happens after my trial?",
    a: (
      <>
        Nothing is deleted. If you choose a plan, everything carries on exactly as it was. If you
        don&rsquo;t, the profit intelligence features switch off but your account, your QuickBooks
        connection and your analyzed jobs all stay in place. Subscribing later turns everything
        back on as you left it.
      </>
    ),
  },
  {
    q: "Can my accountant use JobProfitAI?",
    a: (
      <>
        Yes. Accountants, bookkeepers and fractional CFOs use JobProfitAI with their contractor
        clients, and there&rsquo;s a{" "}
        <Link href="/partners" className="font-medium text-jp-blue hover:underline">
          partner program
        </Link>{" "}
        for firms that work with several. Being your accountant doesn&rsquo;t automatically give
        them access to your numbers. You have to grant that deliberately.
      </>
    ),
  },
  {
    q: "How secure is my financial data?",
    a: (
      <>
        Your QuickBooks tokens and company ID are encrypted before they&rsquo;re stored, every
        account&rsquo;s data is isolated from every other account, and payment card details are
        handled entirely by Stripe and never touch our systems. We&rsquo;ve written up exactly what
        we do and don&rsquo;t do on the{" "}
        <Link href="/security" className="font-medium text-jp-blue hover:underline">
          security page
        </Link>
        , including the things we haven&rsquo;t done yet.
      </>
    ),
  },
  {
    q: "Can I cancel anytime?",
    a: (
      <>
        Yes. Plans are month to month and you can cancel yourself from your billing settings at any
        time, through Stripe&rsquo;s billing portal. There&rsquo;s no contract and no cancellation
        phone call.
      </>
    ),
  },
];

export default function HomePage() {
  return (
    <>
      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <Section className="!pb-10 sm:!pb-12">
        <div className="mx-auto max-w-3xl text-center">
          <Eyebrow>Profit Intelligence for QuickBooks</Eyebrow>
          <h1 className="text-4xl font-bold leading-[1.12] tracking-tight text-jp-ink sm:text-5xl lg:text-[3.4rem]">
            Know which jobs are making you money, and which ones are costing you.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-jp-slate">
            JobProfitAI turns your QuickBooks data into clear job profitability, margin insights,
            profit alerts, and actionable recommendations, so you can catch profit leaks before
            they become expensive.
          </p>

          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <ButtonLink href="/signup" size="lg" className="w-full sm:w-auto">
              Start Your 14-Day Free Trial
            </ButtonLink>
            <ButtonLink href="/how-it-works" size="lg" variant="secondary" className="w-full sm:w-auto">
              See How It Works
            </ButtonLink>
          </div>

          <p className="mt-5 text-sm text-jp-muted">14 days free. No credit card required.</p>

          <ul className="mx-auto mt-9 flex max-w-2xl flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-jp-slate">
            {[
              "Connect QuickBooks",
              "Understand profitability",
              "Receive actionable insights",
              "No complicated spreadsheets",
            ].map((item) => (
              <li key={item} className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-jp-green" aria-hidden="true" />
                {item}
              </li>
            ))}
          </ul>
        </div>

        <div className="mx-auto mt-14 max-w-5xl">
          <DashboardPreview />
        </div>
      </Section>

      {/* ── Problem ──────────────────────────────────────────────────── */}
      <Section tone="surface">
        <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
          <div>
            <SectionHeading
              eyebrow="The problem"
              title="QuickBooks records what happened. It doesn't tell you what it means."
              intro="Your accounting system is a faithful record of money in and money out. But at the end of a month, you're still the one left answering the questions that actually decide whether the business makes money."
            />
          </div>
          <div>
            <ul className="space-y-3">
              {QUESTIONS.map((question) => (
                <li
                  key={question}
                  className="flex items-start gap-3 rounded-lg border border-jp-line bg-white px-4 py-3.5"
                >
                  <span className="mt-0.5 text-jp-muted" aria-hidden="true">
                    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                      <circle cx="9" cy="9" r="7.25" stroke="currentColor" strokeWidth="1.4" />
                      <path
                        d="M6.9 6.9a2.1 2.1 0 113.02 1.88c-.55.28-.92.83-.92 1.45v.27"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinecap="round"
                      />
                      <circle cx="9" cy="13" r=".85" fill="currentColor" />
                    </svg>
                  </span>
                  <span className="text-[15px] font-medium text-jp-ink">{question}</span>
                </li>
              ))}
            </ul>
            <p className="mt-7 text-lg font-semibold leading-relaxed text-jp-ink">
              JobProfitAI turns accounting data into profit intelligence.
            </p>
          </div>
        </div>
      </Section>

      {/* ── Core value ───────────────────────────────────────────────── */}
      <Section>
        <SectionHeading
          eyebrow="What you get"
          title="Profit intelligence, not another dashboard to check"
          intro="Everything here runs off the job, revenue and cost data already in your QuickBooks company. Nothing to re-enter, no spreadsheets to maintain."
          align="center"
        />
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <ValueCard
            title="Job Profitability"
            body="See revenue, costs, gross profit, and margin by job, with the cost breakdown behind every number."
          />
          <ValueCard
            title="Margin Leak Detection"
            body="Quickly identify jobs where costs or profitability are moving in the wrong direction, with the dollar impact attached."
          />
          <ValueCard
            title="Profit Intelligence"
            body="Turn financial results into understandable observations and next actions, each traceable back to the jobs behind it."
          />
          <ValueCard
            title="Weekly Profit Brief"
            body="Automatically receive the most important profitability insights rather than constantly checking reports."
          />
          <ValueCard
            title="Historical Trends"
            body="Understand how margins and profitability are changing over time, by month or by quarter."
          />
          <ValueCard
            title="Data Health"
            body="See exactly where your QuickBooks data is incomplete. Missing estimates, untagged costs. Instead of getting numbers that quietly guess."
          />
        </div>
      </Section>

      {/* ── How it works ─────────────────────────────────────────────── */}
      <Section tone="surface">
        <SectionHeading
          eyebrow="How it works"
          title="Three steps, about two minutes of setup"
          align="center"
        />
        <div className="grid gap-10 sm:grid-cols-3">
          <StepCard
            number={1}
            title="Connect QuickBooks"
            body="Securely connect your QuickBooks Online account through Intuit's own login. You never give JobProfitAI your QuickBooks password."
          />
          <StepCard
            number={2}
            title="JobProfitAI analyzes the numbers"
            body="Your jobs, revenue, costs and accounting history are turned into understandable profitability intelligence. Job by job."
          />
          <StepCard
            number={3}
            title="Know where profit is being made and lost"
            body="See what deserves your attention right now, and what actions may improve profitability on the work ahead."
          />
        </div>
        <div className="mt-12 text-center">
          <ButtonLink href="/how-it-works" variant="secondary" size="lg">
            See How It Works in detail
          </ButtonLink>
        </div>
      </Section>

      {/* ── Intelligence / action ────────────────────────────────────── */}
      <Section>
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
          <div>
            <SectionHeading
              eyebrow="Not just another report"
              title={
                <>
                  Know what happened. Understand why.
                  <br className="hidden sm:block" /> Know what to do next.
                </>
              }
              intro="A report tells you a job came in 14% over. That's the easy part. The value is in knowing it's a pattern across your roofing work, what it has cost you so far, and what to change before you quote the next one."
            />
            <ul className="space-y-4">
              {[
                {
                  t: "Every finding is traceable",
                  b: "Each insight names the specific jobs behind it, so you can check the reasoning rather than take it on faith.",
                },
                {
                  t: "Numbers come from your data, not the AI",
                  b: "Dollar amounts, percentages and confidence levels are calculated by the application. The AI writes the explanation around figures it isn't allowed to change.",
                },
                {
                  t: "Gaps are stated, not filled in",
                  b: "When a job has no estimate on file, JobProfitAI says so instead of inventing a baseline to compare against.",
                },
              ].map((item) => (
                <li key={item.t} className="flex gap-3">
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-jp-green" aria-hidden="true" />
                  <div>
                    <p className="font-semibold text-jp-ink">{item.t}</p>
                    <p className="mt-0.5 text-[15px] leading-relaxed text-jp-slate">{item.b}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <InsightPreview />
        </div>
      </Section>

      {/* ── Weekly brief ─────────────────────────────────────────────── */}
      <Section tone="surface">
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
          <WeeklyBriefPreview />
          <div className="lg:order-first">
            <SectionHeading
              eyebrow="Weekly Profit Brief"
              title="Your most important profit insights, delivered automatically"
              intro="You shouldn't have to remember to go looking for problems. Once a week, at a day and time you choose, JobProfitAI emails the things that actually moved, the job furthest over budget, the margins trending down, the profit at risk right now."
            />
            <ul className="space-y-3 text-[15px] text-jp-slate">
              {[
                "Sent on the day and hour you pick, in your timezone",
                "Goes to you, your PM, your bookkeeper, as many recipients as you want",
                "Leads with the most consequential thing, not an even summary of everything",
                "If your data is too incomplete to say anything reliable, it tells you that instead of guessing",
              ].map((item) => (
                <li key={item} className="flex gap-2.5">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-jp-green" aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      {/* ── Accountants ──────────────────────────────────────────────── */}
      <Section>
        <Card className="border-jp-line bg-jp-surface-2/50 p-8 sm:p-10">
          <div className="grid items-center gap-8 lg:grid-cols-[1.5fr_1fr]">
            <div>
              <Eyebrow>For accountants &amp; bookkeepers</Eyebrow>
              <h2 className="text-2xl font-bold tracking-tight text-jp-ink sm:text-3xl">
                Help your contractor clients understand their profitability.
              </h2>
              <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-jp-slate">
                You already have their QuickBooks data. JobProfitAI turns it into the job-level
                profitability conversation your contractor clients keep asking you for, without
                building a spreadsheet for each one. Firms working with several contractors can join
                the JobProfitAI Partner Program and earn recurring commission.
              </p>
              <p className="mt-3 text-sm leading-relaxed text-jp-muted">
                Referring a client never gives you access to their financial data. That always
                requires their explicit permission.
              </p>
            </div>
            <div className="flex flex-col gap-3">
              <ButtonLink href="/partners" size="lg">
                Explore the Partner Program
              </ButtonLink>
              <ButtonLink href="/contact" size="lg" variant="secondary">
                Talk to us first
              </ButtonLink>
            </div>
          </div>
        </Card>
      </Section>

      {/* ── Pricing preview ──────────────────────────────────────────── */}
      <Section tone="surface" id="pricing">
        <SectionHeading
          eyebrow="Pricing"
          title="Two plans. Both include the intelligence."
          intro="Find one costly margin problem and JobProfitAI can pay for itself. Every plan includes the insights and recommendations. The higher tier adds scale and deeper analysis on top; it doesn't unlock the core promise."
          align="center"
        />
        <PricingCards compact />
        <div className="mt-10 text-center">
          <ButtonLink href="/pricing" variant="secondary">
            Compare plans in detail
          </ButtonLink>
        </div>
      </Section>

      {/* ── FAQ ──────────────────────────────────────────────────────── */}
      <Section>
        <SectionHeading eyebrow="Questions" title="Frequently asked questions" align="center" />
        <div className="mx-auto max-w-3xl">
          <Faq items={FAQ_ITEMS} />
        </div>
      </Section>

      <FinalCta />
    </>
  );
}
