import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getConnectionProfitData, type JobFinancials } from "@/lib/profitability";
import { resolveStatusFilter, STATUS_OPTIONS } from "@/lib/dateRange";
import { formatCurrency, formatPct, formatDate } from "@/lib/format";
import { ConfidenceBadge } from "@/components/dashboard/Badges";
import SortSelect from "@/components/dashboard/SortSelect";

type SortKey =
  | "lowest_margin"
  | "highest_margin"
  | "highest_revenue"
  | "largest_profit"
  | "largest_loss"
  | "largest_variance"
  | "highest_risk";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "lowest_margin", label: "Lowest margin" },
  { key: "highest_margin", label: "Highest margin" },
  { key: "highest_revenue", label: "Highest revenue" },
  { key: "largest_profit", label: "Largest profit" },
  { key: "largest_loss", label: "Largest loss" },
  { key: "largest_variance", label: "Largest estimate variance" },
  { key: "highest_risk", label: "Highest risk" },
];

function sortJobs(jobs: JobFinancials[], sort: SortKey): JobFinancials[] {
  const sorted = [...jobs];
  switch (sort) {
    case "lowest_margin":
      return sorted.sort((a, b) => (a.grossMarginPct ?? Infinity) - (b.grossMarginPct ?? Infinity));
    case "highest_margin":
      return sorted.sort((a, b) => (b.grossMarginPct ?? -Infinity) - (a.grossMarginPct ?? -Infinity));
    case "highest_revenue":
      return sorted.sort((a, b) => b.revenue - a.revenue);
    case "largest_profit":
      return sorted.sort((a, b) => (b.grossProfit ?? -Infinity) - (a.grossProfit ?? -Infinity));
    case "largest_loss":
      return sorted.sort((a, b) => (a.grossProfit ?? Infinity) - (b.grossProfit ?? Infinity));
    case "largest_variance":
      return sorted.sort((a, b) => Math.abs(b.varianceVsEstimate ?? 0) - Math.abs(a.varianceVsEstimate ?? 0));
    case "highest_risk":
      // "Risk" = furthest below target margin, in dollar terms (revenue * gap%) - jobs with no target/no margin sink to the bottom.
      return sorted.sort((a, b) => riskScore(b) - riskScore(a));
    default:
      return sorted;
  }
}

function riskScore(j: JobFinancials): number {
  if (j.targetMarginPct == null || j.grossMarginPct == null) return -Infinity;
  const gap = j.targetMarginPct - j.grossMarginPct * 100;
  return gap > 0 ? gap * j.revenue : -Infinity;
}

export default async function JobsPage({
  searchParams,
}: {
  searchParams: { sort?: string; status?: string };
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const connection = await prisma.quickBooksConnection.findFirst({
    where: { userId: session.userId, disconnectedAt: null },
    orderBy: { connectedAt: "desc" },
  });

  if (!connection) {
    return (
      <main>
        <h1 className="text-2xl font-bold text-navy">Jobs</h1>
        <p className="mt-4 text-gray-600">Connect QuickBooks from the Dashboard to see your jobs here.</p>
      </main>
    );
  }

  const statusFilter = resolveStatusFilter(searchParams.status);
  const sort: SortKey = (SORT_OPTIONS.find((s) => s.key === searchParams.sort)?.key ?? "lowest_margin") as SortKey;

  // Full lifetime data on purpose (no date-range filter) - a job's true
  // profitability shouldn't be sliced by a calendar window (see the Dashboard
  // page, which does apply a period filter for "how much did we invoice this
  // month"-style KPIs; this table answers "is this job profitable," a
  // lifetime question).
  const profitData = await getConnectionProfitData(connection.id, new Date(), { statusFilter });
  const jobs = sortJobs(profitData.jobs, sort);

  const linkWithParams = (overrides: Record<string, string>) => {
    const params = new URLSearchParams({ sort, status: statusFilter, ...overrides });
    return `/dashboard/jobs?${params.toString()}`;
  };

  return (
    <main>
      <h1 className="text-2xl font-bold text-navy">Profitability by Job</h1>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap gap-1 rounded-lg border border-gray-200 p-1">
          {STATUS_OPTIONS.map((s) => (
            <Link
              key={s.key}
              href={linkWithParams({ status: s.key })}
              className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                statusFilter === s.key ? "bg-navy text-white" : "text-gray-600 hover:bg-gray-50"
              }`}
            >
              {s.label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          Sort by:
          <SortSelect sort={sort} status={statusFilter} options={SORT_OPTIONS} />
        </div>
      </div>

      {jobs.length === 0 ? (
        <p className="mt-8 text-sm text-gray-500">No jobs match this filter yet.</p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">Job</th>
                <th className="px-4 py-2 font-medium">Customer</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Revenue</th>
                <th className="px-4 py-2 font-medium">Est. Cost</th>
                <th className="px-4 py-2 font-medium">Actual Cost</th>
                <th className="px-4 py-2 font-medium">Gross Profit</th>
                <th className="px-4 py-2 font-medium">Gross Margin</th>
                <th className="px-4 py-2 font-medium">Target</th>
                <th className="px-4 py-2 font-medium">Variance</th>
                <th className="px-4 py-2 font-medium">Confidence</th>
                <th className="px-4 py-2 font-medium">Last Activity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {jobs.map((j) => (
                <tr key={j.jobId} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-navy">
                    <Link href={`/dashboard/jobs/${j.jobId}`} className="hover:underline">
                      {j.jobName}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{j.customerName ?? "—"}</td>
                  <td className="px-4 py-3 text-gray-600 capitalize">{j.status}</td>
                  <td className="px-4 py-3 text-gray-600">{formatCurrency(j.revenue)}</td>
                  <td className="px-4 py-3 text-gray-600">{formatCurrency(j.estimatedCost)}</td>
                  <td className="px-4 py-3 text-gray-600">{formatCurrency(j.costs)}</td>
                  <td className="px-4 py-3 text-gray-600">
                    {j.profitabilityAvailable ? formatCurrency(j.grossProfit) : "—"}
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {j.profitabilityAvailable ? formatPct(j.grossMarginPct) : "Unavailable"}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{j.targetMarginPct != null ? `${j.targetMarginPct}%` : "—"}</td>
                  <td className="px-4 py-3 text-gray-600">
                    {j.varianceVsEstimate != null ? formatCurrency(j.varianceVsEstimate) : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <ConfidenceBadge confidence={j.dataConfidence} />
                  </td>
                  <td className="px-4 py-3 text-gray-500">{formatDate(j.lastFinancialActivity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
