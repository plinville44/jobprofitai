import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import UpgradeRequired from "@/components/dashboard/UpgradeRequired";
import { prisma } from "@/lib/prisma";
import { decryptToken } from "@/lib/crypto";
import { getConnectionProfitData, getMarginTrend } from "@/lib/profitability";
import { CLOSED_JOB_WHERE } from "@/lib/jobStatus";
import { needsReconnect } from "@/lib/quickbooks";
import { resolveDateRange, resolveStatusFilter, RANGE_OPTIONS, STATUS_OPTIONS } from "@/lib/dateRange";
import { NO_VALUE, confidenceLabel, formatCurrency, formatDate, formatDateTime, formatPct } from "@/lib/format";
import { SeverityBadge } from "@/components/dashboard/Badges";
import DashboardActions from "./DashboardActions";
import FirstRunSetup from "@/components/dashboard/FirstRunSetup";
import JobMarginBarChart from "@/components/charts/JobMarginBarChart";
import EstimateVsActualChart from "@/components/charts/EstimateVsActualChart";
import MarginTrendChart from "@/components/charts/MarginTrendChart";
import DataHealthSummary from "@/components/dashboard/DataHealthSummary";

export default async function DashboardPage(props: {
  // Next.js 16: searchParams arrives as a Promise. Awaited into a local of
  // the same name so every reference below reads exactly as it did before.
  searchParams: Promise<{
    qbo_connected?: string;
    qbo_error?: string;
    range?: string;
    from?: string;
    to?: string;
    status?: string;
    trend?: string;
  }>;
}) {
  const searchParams = await props.searchParams;
  const session = await getSession();
  if (!session) redirect("/login");

  // Server-side entitlement gate. An expired trial gets a proper "choose a
  // plan" screen rather than an authorization error - and because the check
  // happens here, before any financial data is loaded, a lapsed account
  // never has its numbers computed and sent to the browser either.
  const entitlements = await getEntitlements(session.userId);
  if (!entitlements.active) {
    return <UpgradeRequired access={entitlements.access} />;
  }

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
  // Periods follow the customer's own calendar (the connection's timezone,
  // the same one the Weekly Profit Brief is scheduled in), not the server's.
  const { range: dateRange, key: rangeKey, label: rangeLabel } = resolveDateRange(
    searchParams.range,
    searchParams.from,
    searchParams.to,
    now,
    connections[0]?.emailTimezone ?? "UTC"
  );
  const statusFilter = resolveStatusFilter(searchParams.status);
  const trendGranularity = searchParams.trend === "quarterly" ? "quarterly" : "monthly";

  const profitData = connection
    ? await getConnectionProfitData(connection.id, now, { dateRange, statusFilter })
    : null;
  const marginTrend = connection ? await getMarginTrend(connection.id, trendGranularity) : [];

  // Only fetched when the trend has nothing to draw, purely so the empty
  // state can say WHICH of the three reasons it is. The overwhelmingly
  // common one is that no job has been marked completed, and "not enough
  // history" told a contractor with forty finished jobs to sit and wait.
  const trendDiagnosis = connection && marginTrend.length === 0
    ? {
        totalJobs: await prisma.job.count({ where: { connectionId: connection.id } }),
        completedJobs: await prisma.job.count({
          where: { connectionId: connection.id, ...CLOSED_JOB_WHERE },
        }),
      }
    : null;

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

      {/* The first sync now starts on its own (FirstRunSetup below), so
          this only confirms the connection instead of asking for a click. */}
      {searchParams.qbo_connected && connection?.lastSyncedAt && (
        <p className="mt-4 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-800">
          QuickBooks connected.
        </p>
      )}
      {searchParams.qbo_error && (
        <p className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
          QuickBooks connection failed ({searchParams.qbo_error}). Try again below.
        </p>
      )}

      {connections.length === 0 || !connection || !profitData ? (
        <div className="mt-8 rounded-xl border border-gray-200 p-8 text-center">
          <p className="text-gray-600">Connect your QuickBooks Online company to see your job profitability.</p>
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
              Last synced:{" "}
              {connection.lastSyncedAt ? formatDateTime(connection.lastSyncedAt, connection.emailTimezone) : "never"}
            </p>
            {/* A revoked connection still counts as connected, so the
                Connect button is hidden. This is the way back. */}
            {needsReconnect(connection.lastSyncError) ? (
              <div className="mt-3 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
                {connection.lastSyncError}{" "}
                <a
                  href={`/api/quickbooks/connect?reconnect=${connection.id}`}
                  className="font-semibold underline"
                >
                  Reconnect QuickBooks
                </a>
              </div>
            ) : null}
            <DashboardActions connectionId={connection.id} />
            {/* A company that has never synced gets its first sync and first
                brief run automatically, instead of a dashboard of zeros. */}
            {(!connection.lastSyncedAt || searchParams.qbo_connected) &&
            !needsReconnect(connection.lastSyncError) ? (
              <FirstRunSetup connectionId={connection.id} neverSynced={!connection.lastSyncedAt} />
            ) : null}
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
          {/* Says which numbers the period actually moves. Revenue, costs and
              margin are period questions; whether a job is over its estimate
              or missing cost data is not, and those panels deliberately keep
              reading the whole job. Without this line the two sets of figures
              on one screen look like they disagree. */}
          <p className="mt-2 text-xs text-gray-400">
            Showing {rangeLabel.toLowerCase()}, {statusFilter} jobs. The top row and the two charts
            follow the period. Tiles marked &ldquo;whole job&rdquo;, Needs Your Attention and the
            margin trend cover each job from start to finish. Data Health always covers every job.
          </p>

          {/* KPI cards */}
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {/* Follows the tab AND the period: jobs with money in the period.
                Named for that, because "Active Jobs" also means "every open
                job" on the billing page, where the plan limit counts them,
                and the two numbers are different on purpose. */}
            <KpiCard
              label={
                statusFilter === "open"
                  ? "Active Jobs With Activity"
                  : statusFilter === "closed"
                    ? "Completed Jobs With Activity"
                    : "Jobs With Activity"
              }
              value={String(profitData.totals.jobsInView)}
            />
            <KpiCard label="Revenue" value={formatCurrency(profitData.totals.revenue)} />
            <KpiCard label="Tracked Job Costs" value={formatCurrency(profitData.totals.trackedJobCosts)} />
            <KpiCard label="Job Gross Profit" value={formatCurrency(profitData.totals.jobGrossProfit)} />
            <KpiCard label="Average Job Margin" value={formatPct(profitData.totals.avgJobMarginPct)} />
            <KpiCard
              label="Your Target Margin"
              value={profitData.totals.targetMarginPct != null ? `${profitData.totals.targetMarginPct}%` : "Not set"}
            />
            <KpiCard label="Jobs Below Target" wholeJob value={String(profitData.totals.jobsBelowTarget)} tone={profitData.totals.jobsBelowTarget > 0 ? "warning" : undefined} />
            <KpiCard
              label="Profit At Risk"
              wholeJob
              value={formatCurrency(profitData.totals.profitAtRisk)}
              tone={profitData.totals.profitAtRisk > 0 ? "critical" : undefined}
            />
            <KpiCard label="Data Issues" wholeJob value={String(profitData.totals.dataIssues)} tone={profitData.totals.dataIssues > 0 ? "warning" : undefined} />
          </div>

          {/* Needs Attention */}
          <div className="mt-10">
            <h2 className="text-lg font-semibold text-navy">Needs Your Attention</h2>
            {profitData.needsAttention.length === 0 ? (
              /* Three different situations wore the same sentence, and the
                 most common one was "you have no jobs here", which reads as
                 a clean bill of health. The period is not mentioned because
                 this panel no longer depends on it. */
              <p className="mt-2 text-sm text-gray-500">
                {profitData.jobsInTab === 0
                  ? statusFilter === "all"
                    ? "No jobs have synced from QuickBooks yet, so there is nothing to check. JobProfitAI reads jobs from QuickBooks Projects: turn on Projects in QuickBooks (Settings, Account and settings, Advanced), tag invoices and costs to each project, then click Sync now."
                    : `No ${statusFilter === "open" ? "active" : "completed"} jobs to check. Try the All jobs tab.`
                  : `Nothing needs attention on any of your ${profitData.jobsInTab} ${
                      statusFilter === "open" ? "active " : statusFilter === "closed" ? "completed " : ""
                    }${profitData.jobsInTab === 1 ? "job" : "jobs"}, looking at each whole job.`}
              </p>
            ) : (
              <div className="mt-3 overflow-hidden rounded-xl border border-gray-200">
                <table className="w-full text-left text-sm">
                  <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                    <tr>
                      <th className="px-4 py-2 font-medium">Job</th>
                      <th className="px-4 py-2 font-medium">Issue</th>
                      <th className="px-4 py-2 font-medium">Financial Impact</th>
                      <th className="px-4 py-2 font-medium">Severity</th>
                      <th className="px-4 py-2 font-medium">Evidence</th>
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
                            {item.financialImpact != null ? formatCurrency(item.financialImpact) : NO_VALUE}
                          </td>
                          <td className="px-4 py-3">
                            <SeverityBadge severity={item.severity} />
                          </td>
                          <td className="px-4 py-3 text-gray-500">{confidenceLabel(item.confidence)}</td>
                          <td className="px-4 py-3">
                            <Link href={`/dashboard/jobs/${item.jobId}`} className="text-brand hover:underline">
                              View job
                            </Link>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                {/* The list stops at 15; the tiles above count everything. */}
                {profitData.needsAttention.length > 15 ? (
                  <p className="border-t border-gray-100 px-4 py-2 text-xs text-gray-500">
                    Showing the 15 most serious of {profitData.needsAttention.length} items. Each job
                    page lists everything for that job.
                  </p>
                ) : null}
              </div>
            )}
          </div>

          {/* Charts */}
          <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div className="rounded-xl border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-navy">Job Margin by Job</h3>
              <div className="mt-3">
                {/* Each bar is coloured against that job's own target (its
                    job-type target when one is set), the same target Needs
                    Your Attention and Jobs Below Target use. Coloured against
                    the company target, a 25% kitchen job with a 30% kitchen
                    target drew green while being listed as below target. */}
                <JobMarginBarChart
                  data={profitData.jobs
                    .filter((j) => j.grossMarginPct != null)
                    .map((j) => ({
                      jobName: j.jobName,
                      marginPct: j.grossMarginPct! * 100,
                      targetMarginPct: j.targetMarginPct,
                    }))}
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
                {trendDiagnosis ? (
                  <MarginTrendEmptyState {...trendDiagnosis} />
                ) : (
                  <MarginTrendChart
                    data={marginTrend.map((p) => ({ period: p.period, marginPct: p.marginPct == null ? null : p.marginPct * 100 }))}
                    targetMarginPct={profitData.totals.targetMarginPct}
                  />
                )}
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
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-gray-500">
                  Weekly Profit Brief, week of {formatDate(latestDigest.weekStarting)}
                </p>
                {/* The "What changed" part is calculated, not written by AI,
                    so the badge says which part is which. */}
                {latestDigest.kind === "narrative" ? (
                  <span className="text-xs font-semibold uppercase tracking-wide text-brand">
                    Calculated changes, AI summary
                  </span>
                ) : (
                  <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">Data Health notice</span>
                )}
              </div>
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

function KpiCard({
  label,
  value,
  tone,
  wholeJob = false,
}: {
  label: string;
  value: string;
  tone?: "warning" | "critical";
  /** Marks a tile the period picker does not change, on the tile itself. */
  wholeJob?: boolean;
}) {
  const toneClass =
    tone === "critical" ? "border-red-200 bg-red-50" : tone === "warning" ? "border-amber-200 bg-amber-50" : "border-gray-200";
  return (
    <div className={`rounded-xl border p-4 ${toneClass}`}>
      <p className="text-xs text-gray-500">
        {label}
        {wholeJob ? <span className="ml-1.5 text-gray-400">· whole job</span> : null}
      </p>
      <p className="mt-1 text-xl font-bold text-navy">{value}</p>
    </div>
  );
}

/**
 * Why the margin trend is empty, in the customer's terms.
 *
 * The trend compares finished work, and QuickBooks does not tell us when a
 * project is finished, so on most accounts the answer is "nothing is marked
 * completed yet" - a thing the contractor can fix in about ten seconds from
 * the Jobs page. The old single message, "Not enough completed-job history
 * yet to show a trend", described that situation as a waiting game.
 */
function MarginTrendEmptyState({
  totalJobs,
  completedJobs,
}: {
  totalJobs: number;
  completedJobs: number;
}) {
  if (totalJobs === 0) {
    return (
      <p className="text-sm text-gray-500">
        No jobs have synced from QuickBooks yet. Run a sync above and this fills in.
      </p>
    );
  }

  if (completedJobs === 0) {
    return (
      <p className="text-sm text-gray-500">
        None of your {totalJobs} jobs are marked completed yet, and this trend only compares
        finished work. QuickBooks doesn&apos;t tell us when a project wraps up, so you mark them
        here.{" "}
        <Link href="/dashboard/jobs" className="text-brand hover:underline">
          Mark jobs completed
        </Link>{" "}
        (you can select several at once).
      </p>
    );
  }

  return (
    <p className="text-sm text-gray-500">
      Your {completedJobs} completed {completedJobs === 1 ? "job has" : "jobs have"} no invoices or
      costs dated in QuickBooks yet, so there is nothing to plot over time.
    </p>
  );
}
