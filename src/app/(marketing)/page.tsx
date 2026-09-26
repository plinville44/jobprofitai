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
  EstimateCheckPreview,
  OpportunityFeedPreview,
  PricingBreakdownPreview,
  TrackedChangePreview,
  WeeklyBriefPreview,
} from "@/components/marketing/ProductPreview";
import PricingCards from "@/components/marketing/PricingCards";

export const metadata: Metadata = {
  title: "JobProfitAI: Profit Intelligence for QuickBooks",
  description:
    "QuickBooks shows how your jobs did. JobProfitAI shows contractors what to change to make more money, and what each change is worth: underpriced job types, thin labor pricing, and estimates to fix before you send them.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "JobProfitAI: Profit Intelligence for QuickBooks",
    description: "QuickBooks shows how your jobs did. JobProfitAI shows what to change, and what it's worth.",
    url: "/",
  },
};

const QUESTIONS = [
  "Which kind of work actually pays, and which doesn't?",
  "Is this estimate priced high enough to hit my margin?",
  "Is it labor, materials or subs where my price runs thin?",
  "Which customers and job sizes cost me money?",
  "What is each fix worth, in dollars?",
  "Did the price change I made actually work?",
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
    q: "QuickBooks already shows project profitability. What does this add?",
    a: (
      <>
        QuickBooks shows what each job made. JobProfitAI works across all your jobs and turns that
        into what to change: which job types, customers and job sizes are priced below your target
        and by how much, whether labor, materials or subs is the thin part of your price, and
        whether a pending estimate is priced high enough before it goes out. Each one comes with a
        dollar figure, the jobs behind it and what to do, and when you make a change, JobProfitAI
        measures whether it worked. It also builds the WIP (over and under billing) report, emails
        you when a job goes over its estimate, and shows what&rsquo;s missing from your books before
        you trust a number.
      </>
    ),
  },
  {
    q: "How are the dollar figures worked out?",
    a: (
      <>
        From your QuickBooks data and the target margin you set, and every opportunity shows its
        working. For finished jobs, the figure is the price that would have hit your target on the
        same costs, minus what the jobs actually sold for, over the last 12 months. For a pending
        estimate, it&rsquo;s what your own similar finished jobs actually cost for every dollar
        charged, applied to that estimate. AI writes the advisor notes; it never produces a number.
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
        No. JobProfitAI reads your jobs from QuickBooks <strong>Projects</strong>{" "}
        (sub-customers), or, if you make one customer per job, from your customers. It works out
        which on the first sync, and you can switch in Settings. If you track job cost by Class
        instead, it won&rsquo;t find your jobs yet. Classes are on the roadmap, not in the product.
        Beyond that, you will get more out of it if costs are consistently tagged to jobs, and the
        built-in Data Health page tells you exactly where that&rsquo;s incomplete rather than
        quietly guessing. If your QuickBooks estimates put labor, materials and subs on separate
        lines, JobProfitAI can also tell you which part of your price is thin.
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
        JobProfitAI is built for accountants, bookkeepers and fractional CFOs to use alongside
        their contractor clients, and there&rsquo;s a{" "}
        <Link href="/partners" className="font-medium text-jp-blue hover:underline">
          partner program
        </Link>{" "}
        for firms that work with several. Give your accountant or bookkeeper their own login from
        Settings: Profit Intelligence includes 3 team logins and Pro includes 10. They see the same
        jobs and reports you do; billing and who has access stay with you. A QuickBooks company can
        be connected to one JobProfitAI account at a time.
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
            QuickBooks shows how your jobs did. JobProfitAI shows what to change, and what it&rsquo;s worth.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-jp-slate">
            It reads your QuickBooks jobs and estimates, compares every finished job with the ones
            like it, and hands you a ranked list of dollar opportunities: the job type you&rsquo;re
            underpricing, the part of your price that&rsquo;s too thin, the estimate to fix before it
            goes out.
          </p>

          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <ButtonLink href="/signup" size="lg" className="w-full sm:w-auto">
              Start Your 14-Day Free Trial
            </ButtonLink>
            <ButtonLink href="/demo" size="lg" variant="secondary" className="w-full sm:w-auto">
              See It With Sample Data
            </ButtonLink>
          </div>

          <p className="mt-5 text-sm text-jp-muted">14 days free. No credit card required.</p>

          <ul className="mx-auto mt-9 flex max-w-2xl flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-jp-slate">
            {[
              "A dollar figure on every recommendation",
              "Pending estimates checked against your past jobs",
              "Learns from your own finished jobs",
              "Shows whether the change worked",
            ].map((item) => (
              <li key={item} className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-jp-green" aria-hidden="true" />
                {item}
              </li>
            ))}
          </ul>
        </div>

        <div className="mx-auto mt-14 max-w-4xl">
          <OpportunityFeedPreview />
        </div>
      </Section>

      {/* ── QuickBooks vs. the profit layer ──────────────────────────── */}
      <Section tone="surface">
        <SectionHeading
          eyebrow="Works with QuickBooks"
          title="QuickBooks is your system of record. JobProfitAI is the profit layer on top of it."
          intro="Nothing to re-enter and nothing to switch. JobProfitAI only reads QuickBooks, and you keep working there exactly as you do now."
          align="center"
        />
        <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-2">
          <Card className="p-7">
            <p className="text-sm font-semibold uppercase tracking-wide text-jp-muted">QuickBooks tells you</p>
            <ul className="mt-4 space-y-3 text-[15px] text-jp-slate">
              {[
                "What each job billed and what it spent",
                "Profit and loss by project",
                "Budget against actual, where you've set a budget up",
              ].map((item) => (
                <li key={item} className="flex gap-2.5">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>
          </Card>
          <Card className="border-jp-blue/30 p-7">
            <p className="text-sm font-semibold uppercase tracking-wide text-jp-blue">JobProfitAI tells you</p>
            <ul className="mt-4 space-y-3 text-[15px] text-jp-ink">
              {[
                "What to change on your pricing, ranked by what it's worth in dollars",
                "Which job types, customers and job sizes don't hit your margin, and by how much",
                "Whether labor, materials, subs or equipment is the thin part of your price",
                "Whether a pending estimate is priced high enough, before you send it",
                "Whether the change you made is working, on the jobs that follow it",
              ].map((item) => (
                <li key={item} className="flex gap-2.5">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-jp-green" aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </Section>

      {/* ── Problem ──────────────────────────────────────────────────── */}
      <Section>
        <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
          <div>
            <SectionHeading
              eyebrow="The problem"
              title="Knowing a job lost money doesn't tell you what to charge for the next one."
              intro="Your books are a faithful record of money in and money out. But the questions that decide whether next year is more profitable are still yours to answer, usually with a spreadsheet you never get round to building."
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
              JobProfitAI answers them from your own jobs, with a dollar figure on each.
            </p>
          </div>
        </div>
      </Section>

      {/* ── Core value ───────────────────────────────────────────────── */}
      <Section tone="surface">
        <SectionHeading
          eyebrow="What you get"
          title="Not another report. A list of what to change, and what it's worth."
          intro="Revenue, costs and estimates come straight from your QuickBooks company. The one thing QuickBooks can't tell us, what kind of job each one is, we suggest from the job names and estimates for you to confirm."
          align="center"
        />
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <ValueCard
            title="Profit Opportunity Feed"
            body="A ranked list of what to change, each with a dollar value, the jobs behind it, how sure we are, and exactly what to do."
          />
          <ValueCard
            title="Estimate Check"
            body="Every pending QuickBooks estimate, checked against what your own similar jobs actually cost. Catch a thin price before the customer sees it."
          />
          <ValueCard
            title="Pricing by part of the job"
            body="See whether labor, materials, subs or equipment is where your price runs thin, and how much to add to it."
          />
          <ValueCard
            title="Your job types"
            body="Compare kitchens with kitchens and roofs with roofs. Use ours, rename them, or add your own, each with its own target margin."
          />
          <ValueCard
            title="Results you can see"
            body="Tell JobProfitAI you're making a change and it measures it: the margin before, the margin on the jobs that follow, and the dollars it made."
          />
          <ValueCard
            title="Weekly Profit Brief"
            body="Leads with the money: new margin risk on open jobs, estimates to fix, and your biggest opportunity. Then what changed."
          />
        </div>
        <p className="mx-auto mt-10 max-w-3xl text-center text-[15px] leading-relaxed text-jp-slate">
          Built on the basics, done properly: profit by job with labor at real pay rates, the WIP
          report, email alerts when a job goes over its estimate, and a Data Health page that shows
          what&rsquo;s missing from your books before you trust a number.
        </p>
      </Section>

      {/* ── How it works ─────────────────────────────────────────────── */}
      <Section>
        <SectionHeading
          eyebrow="How it works"
          title="Connect in about two minutes. See what to change the same day."
          align="center"
        />
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <StepCard
            number={1}
            title="Connect QuickBooks"
            body="Through Intuit's own login. JobProfitAI only reads your books; you never give it your QuickBooks password."
          />
          <StepCard
            number={2}
            title="Set your target and job types"
            body="Tell us the margin you aim for. We suggest a job type for each job from its name and estimate, and you confirm them in one go."
          />
          <StepCard
            number={3}
            title="See what to change"
            body="Your opportunities, ranked by dollars: underpriced work, thin parts of your price, customers and job sizes that don't pay, open jobs going wrong."
          />
          <StepCard
            number={4}
            title="Check estimates, track results"
            body="Check each pending estimate before it goes out, and track the changes you make to see what they're worth on the next jobs."
          />
        </div>
        <div className="mt-12 text-center">
          <ButtonLink href="/how-it-works" variant="secondary" size="lg">
            See How It Works in detail
          </ButtonLink>
        </div>
      </Section>

      {/* ── Intelligence / action ────────────────────────────────────── */}
      <Section tone="surface">
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
          <div>
            <SectionHeading
              eyebrow="Specific enough to act on"
              title={
                <>
                  Not &ldquo;margins are down.&rdquo;
                  <br className="hidden sm:block" /> Which part of which price, and by how much.
                </>
              }
              intro="A report tells you kitchens came in at 22%. JobProfitAI tells you it's the labor: customers paid for it and it cost nearly as much again. Then it tells you how much to add to the labor on your next kitchen estimate, and what that's worth over a year."
            />
            <ul className="space-y-4">
              {[
                {
                  t: "Every figure shows its working",
                  b: "Each opportunity says how the dollar figure was worked out and names the jobs behind it, so you can check the reasoning rather than take it on faith.",
                },
                {
                  t: "Numbers come from your data, not the AI",
                  b: "Every dollar amount, percentage and confidence level is calculated from your QuickBooks data and your target. AI writes advisor notes around them and never changes one.",
                },
                {
                  t: "It says how sure it is, and why",
                  b: "A pattern across eight jobs is stated more firmly than one across three, in plain words. Gaps in your data are stated, not filled in.",
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
          <PricingBreakdownPreview />
        </div>
      </Section>

      {/* ── Estimate Check ───────────────────────────────────────────── */}
      <Section>
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
          <EstimateCheckPreview />
          <div className="lg:order-first">
            <SectionHeading
              eyebrow="Estimate Check"
              title="Check the price before the customer sees it"
              intro="Every pending estimate in QuickBooks is checked against what your own finished jobs of the same type actually cost for each dollar you charged. If the price won't reach your target margin, you see it, part by part, with the price that would."
            />
            <ul className="space-y-3 text-[15px] text-jp-slate">
              {[
                "Picks up new estimates on the next sync, and says which QuickBooks hasn't emailed yet",
                "Checks labor, materials and subs separately when your estimate splits them",
                "Uses your finished jobs, not an industry average",
                "Read-only: you change the estimate in QuickBooks as you always do",
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

      {/* ── Results tracking ─────────────────────────────────────────── */}
      <Section tone="surface">
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
          <div>
            <SectionHeading
              eyebrow="Results"
              title="Know whether the change paid off"
              intro="When you act on an opportunity, press one button. JobProfitAI records where you started, then compares the jobs you set up in QuickBooks from that day on as they finish. Before, after, and the gross profit the change made, measured on your own jobs."
            />
          </div>
          <TrackedChangePreview />
        </div>
      </Section>

      {/* ── Weekly brief ─────────────────────────────────────────────── */}
      <Section>
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
          <WeeklyBriefPreview />
          <div className="lg:order-first">
            <SectionHeading
              eyebrow="Weekly Profit Brief"
              title="The money first, every week, without logging in"
              intro="Once a week, at a day and time you choose, JobProfitAI emails the headline: new margin risk on your open jobs since last week, estimates priced below target, and your biggest opportunities. Then what changed on each job, and a short written summary."
            />
            <ul className="space-y-3 text-[15px] text-jp-slate">
              {[
                "When there's $500 or more of new risk, or an estimate to fix, the subject line says so",
                "Sent on the day and hour you pick, in your timezone",
                "Goes to up to 10 people: you, your PM, your bookkeeper",
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
      <Section tone="surface">
        <Card className="border-jp-line bg-white p-8 sm:p-10">
          <div className="grid items-center gap-8 lg:grid-cols-[1.5fr_1fr]">
            <div>
              <Eyebrow>For accountants &amp; bookkeepers</Eyebrow>
              <h2 className="text-2xl font-bold tracking-tight text-jp-ink sm:text-3xl">
                Help your contractor clients understand their profitability.
              </h2>
              <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-jp-slate">
                You already have their QuickBooks data. JobProfitAI turns it into the pricing
                conversation your contractor clients keep asking you for: what to charge, where the
                money leaks, and what each fix is worth, without building a spreadsheet for each one. Firms working with several contractors can join
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
      <Section id="pricing">
        <SectionHeading
          eyebrow="Pricing"
          title="Two plans. Both find the money."
          intro="Every plan includes the Profit Opportunity Feed, the Estimate Check and results tracking. Pro adds forecasts for jobs in progress, benchmarking against similar jobs, and more companies and logins. Fix one underpriced job type and it can pay for itself."
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
      <Section tone="surface">
        <SectionHeading eyebrow="Questions" title="Frequently asked questions" align="center" />
        <div className="mx-auto max-w-3xl">
          <Faq items={FAQ_ITEMS} />
        </div>
      </Section>

      <FinalCta />
    </>
  );
}
