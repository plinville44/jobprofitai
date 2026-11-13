import { Card } from "./ui";

/**
 * "QuickBooks tells you / JobProfitAI tells you": the two-column answer to
 * "QuickBooks already does this". One component so the homepage and the ad
 * landing pages (src/app/lp) always say the same thing.
 *
 * Says what QuickBooks does, never what it lacks. Since August 2026
 * QuickBooks Online Advanced includes construction reports (job costing,
 * budget against actual, change orders, WIP) and flags project cost
 * overruns; Plus has project profitability but not those. Since the fall
 * 2026 release (Oct 26), Advanced also has an AI chat (Intuit Intelligence,
 * in beta, admin users only) that answers "how a job's margin compares to
 * similar ones" with tips for the next bid. The right-hand column is what
 * JobProfitAI adds on either plan: every job measured against the
 * contractor's own target margin, each estimate checked before it's sent,
 * without anyone having to ask.
 *
 * Beta, admin-only and plan details are left off the page: they're Intuit's
 * to change, and the page only says what Advanced does.
 */

const QUICKBOOKS = [
  "What each job billed and what it spent",
  "Profit and loss by project",
  "On Advanced, construction reports too: budget against actual, change orders, WIP, and flags when a project's costs run over",
  "On Advanced, an AI chat you can ask how a job's margin compares with similar jobs",
];

const JOBPROFITAI = [
  "What to change on your pricing, ranked by what it's worth in dollars",
  "Which job types, customers and job sizes fall short of your own target margin, and by how much",
  "Whether labor, materials, subs or equipment is the thin part of your price",
  "Whether each pending estimate hits your target margin, before you send it",
  "Whether the change you made is working, on the jobs that follow it",
  "A weekly email of what changed and which estimates to fix, without having to ask",
];

/**
 * The FAQ answer to Intuit's AI on Advanced, shared by the homepage, the
 * pricing page and the ad landing pages so all three say the same thing.
 * Positive about Intuit, like the comparison above. Curly apostrophes, like
 * the other FAQ answers (&rsquo; in JSX).
 */
export const ADVANCED_AI_FAQ = {
  q: "QuickBooks Online Advanced has AI that compares a job’s margin with similar jobs. How is this different?",
  a:
    "Intuit’s AI on Advanced answers the questions you ask it about your jobs. JobProfitAI goes through all " +
    "your jobs without being asked: it sets your finished jobs against the target margin you choose, by job type, " +
    "customer and part of the job, ranks what to change by what it’s worth in dollars, and checks each pending " +
    "estimate against that target before you send it. A weekly email tells you what changed. It works on " +
    "QuickBooks Online Plus as well as Advanced, so there’s no plan upgrade to get it.",
};

export default function QuickBooksComparison() {
  return (
    <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-2">
      <Card className="p-7">
        {/* Not in capitals: QuickBooks keeps its own capitalization (Intuit's requirement 1.4). */}
        <p className="text-sm font-semibold text-jp-muted">QuickBooks tells you</p>
        <ul className="mt-4 space-y-3 text-[15px] text-jp-slate">
          {QUICKBOOKS.map((item) => (
            <li key={item} className="flex gap-2.5">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" aria-hidden="true" />
              {item}
            </li>
          ))}
        </ul>
      </Card>
      <Card className="border-jp-blue/30 p-7">
        <p className="text-sm font-semibold text-jp-blue">JobProfitAI tells you</p>
        <ul className="mt-4 space-y-3 text-[15px] text-jp-ink">
          {JOBPROFITAI.map((item) => (
            <li key={item} className="flex gap-2.5">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-jp-green" aria-hidden="true" />
              {item}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
