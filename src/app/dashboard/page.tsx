import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { decryptToken } from "@/lib/crypto";
import { getConnectionProfitData, getMarginTrend } from "@/lib/profitability";
import { resolveDateRange, resolveStatusFilter, RANGE_OPTIONS, STATUS_OPTIONS } from "@/lib/dateRange";
import { formatCurrency, formatPct } from "@/lib/format";
import { SeverityBadge } from "@/components/dashboard/Badges";
import DashboardActions from "./DashboardActions";
import JobMarginBarChart from "@/components/charts/JobMarginBarChart";
import EstimateVsActualChart from "@/components/charts/EstimateVsActualChart";
import MarginTrendChart from "@/components/charts/MarginTrendChart";
import DataHealthSummary from "@/components/dashboard/DataHealthSummary";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: {
    qbo_connected?: string;
    qbo_error?: string;
    range?: string;
    from?: string;
    to?: string;
    status?: string;
    trend?: string;
  };
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const connections = await prisma.quickBooksConnection.findMany({
    where: { userId: session.userId, disconnectedAt: null },
    orderBy: { connectedAt: "desc" },
  });

  const latestDigest = connections[0]
    ? await prisma.weeklyDigest.findFirst({
        where: { connectionId: connections[0].id },
        orderBy: { weekStarting: "desc" },
      })
    : null;

  const connection = connections[0];
  const now = new Date();
  const { range: dateRange, key: rangeKey, label: rangeLabel } = resolveDateRange(
    searchParams.range,
    searchParams.from,
    searchParams.to,
    now
  );
  const statusFilter = resolveStatusFilter(searchParams.status);
  const trendGranularity = searchParams.trend === "quarterly" ? "quarterly" : "monthly";

  const profitData = connection
    ? await getConnectionProfitData(connection.id, now, { dateRange, statusFilter })
    : null;
  const marginTrend = connection ? await getMarginTrend(connection.id, trendGranularity) : [];

  const linkWithParams = (overrides: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    const merged = { range: rangeKey, status: statusFilter, trend: trendGranularity, ...overrides };
    for (const [k, v] of Object.entries(merged)) {
      if (v) params.set(k, v);
    }
    return `/dashboard?${params.toString()}`;
  };

  return (
    <main>
      <h1 className="text-2xl font-bold text-navy">Profit Dashboard</h1>

      {searchParams.qbo_connected && (
        <p className="mt-4 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-800">
          QuickBooks connected. Click &quot;Sync now&quot; below to pull your job data.
        </p>
      )}
      {searchParams.qbo_error && (
        <p className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
          QuickBooks connection failed ({searchParams.qbo_error}). Try again below.
        </p>
      )}

      {connections.length === 0 || !connection || !profitData ? (
        <div className="mt-8 rounded-xl border border-gray-200 p-8 text-center">
          <p className="text-gray-600">Connect your QuickBooks Online company to get your first digest.</p>
          <a
            href="/api/quickbooks/connect"
            className="mt-4 inline-block rounded-lg bg-brand px-5 py-2.5 font-semibold text-white hover:bg-blue-700"
          >
            Connect to QuickBooks
          </a>
        </div>
      ) : (
        <>
          {/* Connection status + Sync/Digest actions. Disconnect lives on the
              Settings page now (see src/app/dashboard/settings) - Sync now
              and Generate digest stay here since they're the day-to-day
              actions, per the Phase 5 plan. */}
          <div className="mt-6 rounded-xl border border-gray-200 p-6">
            <p className="text-sm text-gray-500">Connected company</p>
            <p className="text-lg font-semibold text-navy">
              {connection.companyName ?? decryptToken(connection.realmId)}
            </p>
            <p className="mt-1 text-xs text-gray-400">
              Cost tracking mode: {connection.costTrackingMode} · Last synced:{" "}
              {connection.lastSyncedAt?.toLocaleString() ?? "never"}
            </p>
            <DashboardActions connectionId={connection.id} />
          </div>

          {/* Filters */}
          <div className="mt-8 flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap gap-1 rounded-lg border border-gray-200 p-1">
              {RANGE_OPTIONS.filter((r) => r.key !== "custom").map((r) => (
                <Link
                  key={r.key}
                  href={linkWithParams({ range: r.key })}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                    rangeKey === r.key ? "bg-navy text-white" : "text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {r.label}
                </Link>
              ))}
            </div>
            <div className="flex flex-wrap gap-1 rounded-lg border border-gray-200 p-1">
              {STATUS_OPTIONS.map((s) => (
                <Link
                  key={s.key}
                  href={linkWithParams({ status: s.key })}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                    statusFilter === s.key ? "bg-navy text-white" : "text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {s.label} jobs
                </Link>
              ))}
            </div>
          </div>
          <p className="mt-2 text-xs text-gray-400">Showing {rangeLabel.toLowerCase()}, {statusFilter} jobs.</p>

          {/* KPI cards */}
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <KpiCard label="Active Jobs" value={String(profitData.totals.activeJobs)} />
            <KpiCard label="Revenue" value={formatCurrency(profitData.totals.revenue)} />
            <KpiCard label="Tracked Job Costs" value={formatCurrency(profitData.totals.trackedJobCosts)} />
            <KpiCard label="Job Gross Profit" value={formatCurrency(profitData.totals.jobGrossProfit)} />
            <KpiCard label="Average Job Margin" value={formatPct(profitData.totals.avgJobMarginPct)} />
            <KpiCard
              label="Your Target Margin"
              value={profitData.totals.targetMarginPct != null ? `${profitData.totals.targetMarginPct}%` : "Not set"}
            />
            <KpiCard label="Jobs Below Target" value={String(profitData.totals.jobsBelowTarget)} tone={profitData.totals.jobsBelowTarget > 0 ? "warning" : undefined} />
            <KpiCard
              label="Profit At Risk"
              value={formatCurrency(profitData.totals.profitAtRisk)}
              tone={profitData.totals.profitAtRisk > 0 ? "critical" : undefined}
            />
            <KpiCard label="Data Issues" value={String(profitData.totals.dataIssues)} tone={profitData.totals.dataIssues > 0 ? "warning" : undefined} />
          </div>

          {/* Needs Attention */}
          <div className="mt-10">
            <h2 className="text-lg font-semibold text-navy">Needs Your Attention</h2>
            {profitData.needsAttention.length === 0 ? (
              <p className="mt-2 text-sm text-gray-500">Nothing needs attention right now for the selected filters.</p>
            ) : (
              <div className="mt-3 overflow-hidden rounded-xl border border-gray-200">
                <table className="w-full text-left text-sm">
                  <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                    <tr>
                      <th className="px-4 py-2 font-medium">Job</th>
                      <th className="px-4 py-2 font-medium">Issue</th>
                      <th className="px-4 py-2 font-medium">Financial Impact</th>
                      <th className="px-4 py-2 font-medium">Severity</th>
                      <th className="px-4 py-2 font-medium">Confidence</th>
                      <th className="px-4 py-2 font-medium"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {[...profitData.needsAttention]
                      .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
                      .slice(0, 15)
                      .map((item, i) => (
                        <tr key={i}>
                          <td className="px-4 py-3 font-medium text-navy">{item.jobName}</td>
                          <td className="px-4 py-3 text-gray-600">{item.issue}</td>
                          <td className="px-4 py-3 text-gray-600">
                            {item.financialImpact != null ? formatCurrency(item.financialImpact) : "—"}
                          </td>
                          <td className="px-4 py-3">
                            <SeverityBadge severity={item.severity} />
                          </td>
                          <td className="px-4 py-3 text-gray-500 capitalize">{item.confidence}</td>
                          <td className="px-4 py-3">
                            <Link href={`/dashboard/jobs/${item.jobId}`} className="text-brand hover:underline">
                              View job
                            </Link>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Charts */}
          <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div className="rounded-xl border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-navy">Job Margin by Job</h3>
              <div className="mt-3">
                <JobMarginBarChart
                  data={profitData.jobs
                    .filter((j) => j.grossMarginPct != null)
                    .map((j) => ({ jobName: j.jobName, marginPct: j.grossMarginPct! * 100 }))}
                  targetMarginPct={profitData.totals.targetMarginPct}
                />
              </div>
            </div>
            <div className="rounded-xl border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-navy">Cost by Category</h3>
              <div className="mt-3">
                <EstimateVsActualChart data={aggregateCostByCategory(profitData.jobs)} />
              </div>
            </div>
            <div className="rounded-xl border border-gray-200 p-5 lg:col-span-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-navy">Margin Trend (completed jobs)</h3>
                <div className="flex gap-1 rounded-lg border border-gray-200 p-1">
                  <Link
                    href={linkWithParams({ trend: "monthly" })}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium ${trendGranularity === "monthly" ? "bg-navy text-white" : "text-gray-600"}`}
                  >
                    Monthly
                  </Link>
                  <Link
                    href={linkWithParams({ trend: "quarterly" })}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium ${trendGranularity === "quarterly" ? "bg-navy text-white" : "text-gray-600"}`}
                  >
                    Quarterly
                  </Link>
                </div>
              </div>
              <div className="mt-3">
                <MarginTrendChart
                  data={marginTrend.map((p) => ({ period: p.period, marginPct: p.marginPct == null ? null : p.marginPct * 100 }))}
                  targetMarginPct={profitData.totals.targetMarginPct}
                />
              </div>
            </div>
          </div>

          {/* Structured Data Health facts come first, with the AI-written
              digest narrative below as additional plain-English context -
              never the other way around, per the "structured info primary,
              AI explanation secondary, never AI alone" product rule. */}
          <div className="mt-10">
            <DataHealthSummary dataHealth={profitData.dataHealth} />
          </div>

          {latestDigest && (
            <div className="mt-6 rounded-xl border border-gray-200 p-6">
              <p className="text-sm text-gray-500">Digest for week of {latestDigest.weekStarting.toLocaleDateString()}</p>
              <pre className="mt-2 whitespace-pre-wrap font-sans text-sm text-navy">{latestDigest.narrative}</pre>
            </div>
          )}
        </>
      )}

      <p className="mt-10 border-t border-gray-200 pt-6 text-xs text-gray-400">
        Need help? Email{" "}
        <a href="mailto:support@jobprofitai.com" className="text-brand hover:underline">
          support@jobprofitai.com
        </a>{" "}
        and we&apos;ll get back to you.
      </p>
    </main>
  );
}

function severityRank(s: "high" | "medium" | "low"): number {
  return { high: 3, medium: 2, low: 1 }[s];
}

function aggregateCostByCategory(jobs: { costByCategory: Record<string, number> }[]) {
  const totals: Record<string, number> = {};
  for (const j of jobs) {
    for (const [cat, amt] of Object.entries(j.costByCategory)) {
      totals[cat] = (totals[cat] ?? 0) + amt;
    }
  }
  return Object.entries(totals)
    .sort(([, a], [, b]) => b - a)
    .map(([category, actual]) => ({ category, actual, estimated: null }));
}

function KpiCard({ label, value, tone }: { label: string; value: string; tone?: "warning" | "critical" }) {
  const toneClass =
    tone === "critical" ? "border-red-200 bg-red-50" : tone === "warning" ? "border-amber-200 bg-amber-50" : "border-gray-200";
  return (
    <div className={`rounded-xl border p-4 ${toneClass}`}>
      <p className="text-xs text-gray-500">{label}</p>
      <p className="mt-1 text-xl font-bold text-navy">{value}</p>
    </div>
  );
}
