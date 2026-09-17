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
  // These eight are exactly the eight things computeDashboardTotals adds up
  // into the "Data Issues" tile, in the same order.
  //
  // The card used to list five of them. When the only non-zero counts were
  // among the missing three, this card said "No data quality issues found"
  // directly below a tile reading "Data Issues: 9" - on the one page whose
  // whole job is telling a contractor which of their numbers to trust. If a
  // check is ever added to that tile, it belongs here too.
  const rows: { label: string; count: number | null }[] = [
    { label: "jobs missing a cost estimate", count: dataHealth.jobsMissingEstimates.length },
    { label: "jobs with revenue but no costs", count: dataHealth.jobsMissingCosts.length },
    { label: "stale jobs (no activity in 30+ days)", count: dataHealth.staleJobs.length },
    {
      label: "completed jobs with unresolved activity",
      count: dataHealth.completedJobsWithUnresolvedActivity.length,
    },
    { label: "unassigned expenses", count: dataHealth.unassignedExpenseCount },
    { label: "expenses tagged to an unrecognized customer", count: dataHealth.unresolvedExpenseCount },
    { label: "time entries with no hourly rate", count: dataHealth.timeEntriesWithoutRate },
    { label: "possible duplicate cost entries", count: dataHealth.possibleDuplicates.length },
  ];
  const flagged = rows.filter((r) => (r.count ?? 0) > 0);
  const unmeasured = rows.filter((r) => r.count == null);

  return (
    <div className="rounded-xl border border-gray-200 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <StatusDot status={flagged.length === 0 ? "good" : "warning"} />
          <h3 className="text-sm font-semibold text-navy">Data Health</h3>
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
              {r.label === "unassigned expenses" && dataHealth.unassignedExpenseAmount ? (
                <span className="text-gray-400"> ({formatCurrency(dataHealth.unassignedExpenseAmount)})</span>
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
