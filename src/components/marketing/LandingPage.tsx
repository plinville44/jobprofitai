import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ButtonLink, CheckIcon, Eyebrow, Faq, Section, SectionHeading } from "./ui";
import {
  EstimateCheckPreview,
  OpportunityFeedPreview,
  PricingBreakdownPreview,
  TrackedChangePreview,
  WipPreview,
} from "./ProductPreview";
import QuickBooksComparison from "./QuickBooksComparison";
import FitCheck from "./FitCheck";
import PricingCards from "./PricingCards";
import { LANDING_PAGES, type LandingSection, type LandingSlug } from "@/lib/landingPages";

/**
 * One ad landing page (src/app/lp/<slug>). A shorter homepage with one job:
 * get the visitor who clicked an ad to start a trial, check the fit, or look
 * at the sample company. No site navigation (src/app/lp/layout.tsx), one
 * button, and a headline that matches the ad group (src/lib/landingPages.ts).
 *
 * Every product picture is a preview from the invented sample company, run
 * through the real engine and labelled "Example data".
 */

export function landingMetadata(slug: LandingSlug): Metadata {
  const page = LANDING_PAGES[slug];
  return {
    title: page.metaTitle,
    description: page.metaDescription,
    // Ads only: the homepage is the page that should rank.
    robots: { index: false, follow: true },
  };
}

const SECTIONS: Record<
  LandingSection,
  { eyebrow: string; title: string; body: string; bullets: string[]; preview: () => ReactNode }
> = {
  feed: {
    eyebrow: "What to change",
    title: "A ranked list of what to change, and what each fix is worth",
    body: "JobProfitAI compares every finished job with the ones like it and ranks what to change by dollars: the job type priced below your target, the customer whose work doesn't pay, the estimate to fix before it goes out, the open job running over.",
    bullets: [
      "A dollar figure on every item, and the jobs behind it",
      "Exactly what to do, in plain words",
      "How sure it is, and why",
    ],
    preview: () => <OpportunityFeedPreview items={3} />,
  },
  breakdown: {
    eyebrow: "Pricing by part of the job",
    title: "Which part of which price, and by how much",
    body: "A report tells you kitchens came in at 22%. JobProfitAI tells you it's the labor: customers paid for it and it cost nearly as much again. Then it tells you how much to raise the labor line on your next kitchen estimate.",
    bullets: [
      "Labor, materials, subs and equipment, compared separately when your estimates list them on separate lines",
      "Uses your own finished jobs, not an industry average",
      "Every figure shows how it was worked out",
    ],
    preview: () => <PricingBreakdownPreview />,
  },
  estimate: {
    eyebrow: "Estimate Check",
    title: "Check the price before the customer sees it",
    body: "Every pending estimate in QuickBooks is checked before you send it: costed from its hours and items where the lines list them, and against what your own finished jobs of the same type actually cost. If the price won't reach your target margin, you see it, with the price that would.",
    bullets: [
      "Picks up new estimates on the next sync, and says which QuickBooks hasn't emailed yet",
      "Shows which line is thinnest",
      "Read-only: you change the estimate in QuickBooks as you always do",
    ],
    preview: () => <EstimateCheckPreview />,
  },
  tracked: {
    eyebrow: "Results",
    title: "Know whether the change paid off",
    body: "When you act on an opportunity, press one button. JobProfitAI records where you started, then compares the jobs you set up from that day on as they finish: before, after, and the gross profit the change made, measured on your own jobs.",
    bullets: [
      "Before and after on the same kind of work",
      "Margin by job type, month by month",
      "No guessing whether the price increase stuck",
    ],
    preview: () => <TrackedChangePreview />,
  },
  wip: {
    eyebrow: "Bank-ready WIP report",
    title: "The WIP schedule your bank and bonding company ask for",
    body: "Contract, estimated total cost, cost to date, percent complete, earned revenue, billed to date, and over and under billing for every open job, with totals and the contracts you finished in the last 12 months. A job that can't be scheduled honestly, like one whose costs have passed its estimate, is listed with what it needs instead of being guessed at.",
    bullets: [
      "Built from QuickBooks on every sync, nothing to re-enter",
      "Print it, save it as a PDF, or download the CSV",
      "Labor at the cost rate on each QuickBooks time entry",
    ],
    preview: () => <WipPreview />,
  },
};

const NUMBERS_YOU_CAN_CHECK = [
  "Labor at the cost rate on each QuickBooks time entry, plus a labor burden only if that rate doesn't already include it",
  "Refunds, supplier credits and sales tax taken out, so revenue and cost mean what they should",
  "Check against QuickBooks on every job: our totals beside QuickBooks' own profit and loss for that job",
  "A list of every cost from the last 12 months that isn't on a job, biggest first, with a link to open it in QuickBooks",
  "Read-only: JobProfitAI never changes anything in your books",
];

function alsoIncluded(slug: LandingSlug): string[] {
  return [
    "Money you're owed: finished work not billed, costs past the estimate that may be unbilled change orders, and unpaid invoices by age",
    ...(slug === "wip" ? [] : ["The bank-ready WIP report, to print or save as a PDF"]),
    "Email alerts after the nightly sync when an open job goes more than 10% over its estimate or gets well ahead of its billing",
    "The Weekly Profit Brief: new margin risk and estimates to fix, first, on the day and time you choose",
    "3 team logins, for your office manager, project manager or bookkeeper",
  ];
}

const FAQ_ITEMS: { q: string; a: ReactNode }[] = [
  {
    q: "QuickBooks already shows project profitability. What does this add?",
    a: (
      <>
        QuickBooks shows what each job made. JobProfitAI works across all your jobs and turns that into what
        to change: which job types, customers and job sizes are priced below your target and by how much,
        whether labor, materials or subs is the thin part of your price, and whether a pending estimate is
        priced high enough before it goes out. When you make a change, it measures whether it worked.
      </>
    ),
  },
  {
    q: "Why not upgrade QuickBooks instead?",
    a: (
      <>
        A higher QuickBooks plan costs more every month and adds construction reports. It doesn&rsquo;t rank
        what to change on your pricing by what it&rsquo;s worth, check each estimate against your own past
        jobs, or show whether a price change worked. JobProfitAI adds those to the QuickBooks Online you
        already have.
      </>
    ),
  },
  {
    q: "Do I need to use QuickBooks Projects?",
    a: (
      <>
        No. JobProfitAI reads your jobs from QuickBooks Projects, from customers if you make one customer per
        job, or from Classes if each job is a class. It works out Projects or customers on the first sync and
        asks you once if it sees Classes. The{" "}
        <Link href="#fit-check" className="font-medium text-jp-blue hover:underline">
          30-second check
        </Link>{" "}
        tells you whether your setup works before you sign up.
      </>
    ),
  },
  {
    q: "How are the dollar figures worked out?",
    a: (
      <>
        From your QuickBooks data and the target margin you set, and every opportunity shows its working. For
        finished jobs, the figure is the price that would have hit your target on the same costs, minus what
        the jobs actually sold for, over the last 12 months. For a pending estimate, it&rsquo;s the estimate&rsquo;s
        hours and items where the lines list them, checked against what your own similar finished jobs
        actually cost. AI writes notes around the numbers; it never produces one.
      </>
    ),
  },
  {
    q: "Is my financial data safe?",
    a: (
      <>
        JobProfitAI connects through Intuit&rsquo;s own login and only reads your books. Your QuickBooks
        tokens are encrypted, your data is never used to train AI, and you can disconnect at any time. The{" "}
        <Link href="/security" className="font-medium text-jp-blue hover:underline">
          security page
        </Link>{" "}
        says exactly what we do and don&rsquo;t do.
      </>
    ),
  },
  {
    q: "Can I cancel anytime?",
    a: (
      <>
        Yes. The trial needs no credit card. Plans are month to month, and you cancel yourself from your
        billing settings, with no contract and no phone call.
      </>
    ),
  },
];

function Bullet({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <CheckIcon className="mt-0.5" />
      <span>{children}</span>
    </li>
  );
}

export default function LandingPage({ slug }: { slug: LandingSlug }) {
  const page = LANDING_PAGES[slug];
  const heroPreview = SECTIONS[page.heroPreview].preview();

  return (
    <>
      {/* Hero: the headline matches the ad group. */}
      <Section className="!pb-10 sm:!pb-12">
        <div className="mx-auto max-w-3xl text-center">
          <Eyebrow>{page.eyebrow}</Eyebrow>
          <h1 className="text-4xl font-bold leading-[1.12] tracking-tight text-jp-ink sm:text-5xl">{page.headline}</h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-jp-slate">{page.subhead}</p>
          <div className="mt-9 flex justify-center">
            <ButtonLink href="/signup" size="lg" className="w-full sm:w-auto">
              Start Your 14-Day Free Trial
            </ButtonLink>
          </div>
          <div className="mt-4 flex flex-col items-center justify-center gap-2 text-sm font-medium sm:flex-row sm:gap-6">
            <Link href="/demo" className="text-jp-blue hover:underline">
              See it with sample data
            </Link>
            <Link href="#fit-check" className="text-jp-blue hover:underline">
              Will this work with my QuickBooks? (30 seconds)
            </Link>
          </div>
          <p className="mt-5 text-sm text-jp-muted">
            14 days free &middot; No credit card &middot; Works with QuickBooks Online: Projects, customers or Classes
          </p>
        </div>
        <div className="mx-auto mt-12 max-w-4xl">{heroPreview}</div>
      </Section>

      {/* The answer to "QuickBooks already does this". */}
      <Section tone="surface">
        <SectionHeading
          eyebrow="Works with QuickBooks"
          title="QuickBooks shows how your jobs did. JobProfitAI shows what to change, and what it's worth."
          intro="Nothing to re-enter and nothing to switch. JobProfitAI only reads QuickBooks, and you keep working there exactly as you do now."
          align="center"
        />
        <QuickBooksComparison />
      </Section>

      {/* The product sections for this ad group, alternating sides. */}
      {page.sections.map((key, i) => {
        const s = SECTIONS[key];
        const previewFirst = i % 2 === 1;
        return (
          <Section key={key} tone={i % 2 === 0 ? "white" : "surface"}>
            <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
              <div className={previewFirst ? "lg:order-last" : undefined}>
                <SectionHeading eyebrow={s.eyebrow} title={s.title} intro={s.body} />
                <ul className="space-y-3 text-[15px] text-jp-slate">
                  {s.bullets.map((b) => (
                    <Bullet key={b}>{b}</Bullet>
                  ))}
                </ul>
              </div>
              <div>{s.preview()}</div>
            </div>
          </Section>
        );
      })}

      {/* Trust, then everything else in the box. */}
      <Section tone={page.sections.length % 2 === 0 ? "white" : "surface"}>
        <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
          <div>
            <SectionHeading
              eyebrow="Numbers you can check"
              title="Built to match your books"
              intro="If the numbers don't match QuickBooks, nothing else on the page gets believed. So every figure can be checked."
            />
            <ul className="space-y-3 text-[15px] text-jp-slate">
              {NUMBERS_YOU_CAN_CHECK.map((b) => (
                <Bullet key={b}>{b}</Bullet>
              ))}
            </ul>
          </div>
          <div>
            <SectionHeading eyebrow="Also included" title="Everything else, on every plan" />
            <ul className="space-y-3 text-[15px] text-jp-slate">
              {alsoIncluded(slug).map((b) => (
                <Bullet key={b}>{b}</Bullet>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      {/* The fit check: the hero links here. */}
      <Section id="fit-check" tone={page.sections.length % 2 === 0 ? "surface" : "white"}>
        <SectionHeading
          eyebrow="30-second check"
          title="Will this work with my QuickBooks?"
          intro="Six quick questions and a straight answer, with the plan that fits. Better to know before you sign up than after."
          align="center"
        />
        <FitCheck />
      </Section>

      <Section tone={page.sections.length % 2 === 0 ? "white" : "surface"}>
        <SectionHeading
          eyebrow="Pricing"
          title="Fix one underpriced job type and it can pay for itself"
          intro="Every plan includes the Profit Opportunity Feed, the Estimate Check and results tracking. 14 days free, no credit card, cancel anytime."
          align="center"
        />
        <PricingCards compact />
      </Section>

      <Section tone={page.sections.length % 2 === 0 ? "surface" : "white"}>
        <SectionHeading eyebrow="Questions" title="Before you start" align="center" />
        <div className="mx-auto max-w-3xl">
          <Faq items={FAQ_ITEMS} />
        </div>
      </Section>

      {/* One action, repeated. */}
      <Section tone="ink">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="text-3xl font-bold leading-tight tracking-tight text-white sm:text-4xl">
            See what to change on your own jobs.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-slate-300">
            Connect QuickBooks Online in about two minutes. Read-only, and nothing in your books changes.
          </p>
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <ButtonLink href="/signup" size="lg" className="w-full sm:w-auto">
              Start Your 14-Day Free Trial
            </ButtonLink>
            <ButtonLink href="/demo" size="lg" variant="onDark" className="w-full sm:w-auto">
              See It With Sample Data
            </ButtonLink>
          </div>
          <p className="mt-5 text-sm text-slate-400">14 days free. No credit card required.</p>
        </div>
      </Section>
    </>
  );
}
