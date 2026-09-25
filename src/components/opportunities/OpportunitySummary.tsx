import Link from "next/link";
import { formatCurrency } from "@/lib/format";
import type { FeedSummary } from "@/lib/opportunities";

/**
 * The four headline figures. Each is computed per job, once, so they can
 * sit side by side without double counting; they are never added together
 * because they are different kinds of money (profit on finished work,
 * profit on open work, price on unsent estimates, and cash owed).
 */
export default function OpportunitySummary({ summary, compact = false }: { summary: FeedSummary; compact?: boolean }) {
  if (!summary.targetSet) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
        <p className="font-semibold">Set your target margin to see what your pricing is costing you.</p>
        <p className="mt-1">
          Every figure here is measured against the margin you aim for. It takes ten seconds, and you can set a
          different one for each job type.
        </p>
        <Link href="/dashboard/settings" className="mt-2 inline-block font-semibold text-brand hover:underline">
          Set your target margin
        </Link>
      </div>
    );
  }
  const tiles = [
    {
      label: "Profit your pricing left behind",
      sub: "Finished jobs, last 12 months",
      value: summary.pricingGap,
      detail:
        summary.jobsJudged === 0
          ? "No finished jobs with revenue and costs in the last 12 months yet."
          : `${summary.jobsBelowTarget} of ${summary.jobsJudged} finished jobs came in below target.`,
      tone: summary.pricingGap > 0 ? "red" : "green",
    },
    {
      label: "At risk on open jobs",
      sub: "Short of target, or over estimate",
      value: summary.openJobRisk,
      detail: summary.openJobsAtRisk === 0 ? "No open job is heading below target." : `${summary.openJobsAtRisk} open ${summary.openJobsAtRisk === 1 ? "job" : "jobs"}.`,
      tone: summary.openJobRisk > 0 ? "red" : "green",
    },
    {
      label: "Estimates priced too low",
      sub: "Pending estimates in QuickBooks",
      value: summary.estimatesShortfall,
      detail:
        summary.estimatesFlagged === 0
          ? "None of your pending estimates is below target."
          : `${summary.estimatesFlagged} pending ${summary.estimatesFlagged === 1 ? "estimate" : "estimates"}.`,
      tone: summary.estimatesShortfall > 0 ? "amber" : "green",
    },
    {
      label: "Finished work not billed",
      sub: "Cash, not profit",
      value: summary.unbilledWork,
      detail: summary.unbilledWork > 0 ? "Money already spent on jobs and not yet asked for." : "Billing is keeping up with the work.",
      tone: summary.unbilledWork > 0 ? "amber" : "green",
    },
  ] as const;
  const toneClass = { red: "text-red-700", amber: "text-amber-700", green: "text-green-700" };
  return (
    <div className={`grid grid-cols-1 gap-3 sm:grid-cols-2 ${compact ? "lg:grid-cols-4" : "lg:grid-cols-4"}`}>
      {tiles.map((t) => (
        <div key={t.label} className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs font-medium text-gray-500">{t.label}</p>
          <p className={`mt-1 text-2xl font-bold ${t.value > 0 ? toneClass[t.tone] : "text-navy"}`}>{formatCurrency(t.value)}</p>
          <p className="text-[11px] uppercase tracking-wide text-gray-400">{t.sub}</p>
          {!compact && <p className="mt-2 text-xs text-gray-500">{t.detail}</p>}
        </div>
      ))}
    </div>
  );
}
