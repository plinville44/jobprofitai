import { Card } from "./ui";

/**
 * "QuickBooks tells you / JobProfitAI tells you": the two-column answer to
 * "QuickBooks already does this". One component so the homepage and the ad
 * landing pages (src/app/lp) always say the same thing.
 */

const QUICKBOOKS = [
  "What each job billed and what it spent",
  "Profit and loss by project",
  "Budget against actual, where you've set a budget up",
];

const JOBPROFITAI = [
  "What to change on your pricing, ranked by what it's worth in dollars",
  "Which job types, customers and job sizes don't hit your margin, and by how much",
  "Whether labor, materials, subs or equipment is the thin part of your price",
  "Whether a pending estimate is priced high enough, before you send it",
  "Whether the change you made is working, on the jobs that follow it",
];

export default function QuickBooksComparison() {
  return (
    <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-2">
      <Card className="p-7">
        <p className="text-sm font-semibold uppercase tracking-wide text-jp-muted">QuickBooks tells you</p>
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
        <p className="text-sm font-semibold uppercase tracking-wide text-jp-blue">JobProfitAI tells you</p>
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
