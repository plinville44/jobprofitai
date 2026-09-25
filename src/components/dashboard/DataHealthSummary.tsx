import Link from "next/link";
import type { DataHealthReport } from "@/lib/profitability";
import { formatCurrency } from "@/lib/format";
import { DataQualityBadge, StatusDot } from "@/components/dashboard/Badges";

/**
 * The compact, structured Data Health card shown on the main dashboard,
 * above the AI-written digest. Per the product spec, an incomplete-data
 * situation should be explained with structured facts first, with any AI
 * narrative appearing below as additional context - never as a replacement
 * for the structured info, and never as the only explanation on its own.
 */
export default function DataHealthSummary({ dataHealth }: { dataHealth: DataHealthReport }) {
  // Every check in the "Data Issues" tile is listed here too. When the card
  // listed fewer, it could say "No data quality issues found" under a tile
  // reading "Data Issues: 9". If a check is added to the tile, add it here.
  // The first seven are exactly what computeDashboardTotals adds into the
  // "Data Issues" tile. Missing estimates are listed after them as setup
  // rather than a data problem, which is why the tile doesn't count them.
  const rows: { label: string; count: number | null }[] = [
    { label: "jobs with revenue but no costs", count: dataHealth.jobsMissingCosts.length },
    { label: "stale jobs (no activity in 30+ days)", count: dataHealth.staleJobs.length },
    {
      label: "completed jobs with unresolved activity",
      count: dataHealth.completedJobsWithUnresolvedActivity.length,
    },
    { label: "job costs not tagged to a job (last 12 months)", count: dataHealth.untaggedJobCostCount },
    { label: "expenses tagged to an unrecognized customer", count: dataHealth.unresolvedExpenseCount },
    { label: "employee time entries with no pay rate", count: dataHealth.timeEntriesWithoutPayRate },
    { label: "possible duplicate cost entries", count: dataHealth.possibleDuplicates.length },
    { label: "open jobs missing a cost estimate (setup)", count: dataHealth.jobsMissingEstimates.length },
  ];
  const flagged = rows.filter((r) => (r.count ?? 0) > 0);
  const unmeasured = rows.filter((r) => r.count == null);

  return (
    <div className="rounded-xl border border-gray-200 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <StatusDot status={flagged.length === 0 ? "good" : "warning"} />
          {/* Every job, whatever tab is selected, like the page it links to. */}
          <h3 className="text-sm font-semibold text-navy">Data Health, open and recent jobs</h3>
          <DataQualityBadge confidence={dataHealth.overallConfidence} />
        </div>
        <Link href="/dashboard/data-health" className="text-sm text-brand hover:underline">
          View full Data Health report →
        </Link>
      </div>

      {flagged.length === 0 ? (
        <p className="mt-3 text-sm text-gray-600">No data quality issues found in what&apos;s been synced so far.</p>
      ) : (
        <ul className="mt-3 space-y-1.5 text-sm text-gray-600">
          {flagged.map((r) => (
            <li key={r.label}>
              <span className="font-medium text-navy">{r.count}</span> {r.label}
              {r.label.startsWith("job costs not tagged") && dataHealth.untaggedJobCostAmount ? (
                <span className="text-gray-400"> ({formatCurrency(dataHealth.untaggedJobCostAmount)})</span>
              ) : null}
              {r.label === "expenses tagged to an unrecognized customer" && dataHealth.unresolvedExpenseAmount ? (
                <span className="text-gray-400"> ({formatCurrency(dataHealth.unresolvedExpenseAmount)})</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {unmeasured.length > 0 && (
        <p className="mt-2 text-xs text-gray-400">
          {unmeasured.length === 1 ? "One item hasn't" : `${unmeasured.length} items haven't`} been measured yet - sync
          QuickBooks to check.
        </p>
      )}
    </div>
  );
}
