import { redirect } from "next/navigation";
import Link from "next/link";
import { getAccount, getActiveConnection } from "@/lib/account";
import { prisma } from "@/lib/prisma";
import { getEntitlements, requireFeature } from "@/lib/entitlements";
import UpgradeRequired from "@/components/dashboard/UpgradeRequired";
import {
  diagnoseOpportunityGap,
  getConnectionProfitData,
  type JobFinancials,
} from "@/lib/profitability";
import { formatCurrency, formatDateTime } from "@/lib/format";
import { ConfidenceBadge } from "@/components/dashboard/Badges";
import RefreshAnalysisButton from "./RefreshAnalysisButton";

function UpgradeNotice({ feature }: { feature: string }) {
  return (
    <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-6 text-sm text-gray-600">
      {feature} is part of Profit Intelligence Pro.{" "}
      <Link href="/dashboard/billing" className="font-medium text-brand hover:underline">
        See plans and upgrade
      </Link>
      .
    </div>
  );
}

/**
 * Says WHY there are no opportunities, not just that there are none.
 *
 * The generic "not enough completed jobs" line covered six different
 * situations, and the most common one for a new customer - job type is blank
 * on every job, and it is the one field QuickBooks cannot supply - looked
 * identical to "the product is broken". diagnoseOpportunityGap works out
 * which situation this actually is; this renders it.
 *
 * "no_pattern_found" is styled differently on purpose. Having enough data
 * and finding nothing is a real answer and a good one, so it should not look
 * like the states that need the customer to go and fix something.
 */
function OpportunityEmptyState({ jobs }: { jobs: JobFinancials[] }) {
  const gap = diagnoseOpportunityGap(jobs);
  const isGoodNews = gap.code === "no_pattern_found";
  const needsJobTypes = gap.code === "no_job_types" || gap.code === "job_types_spread_thin";

  return (
    <div
      className={`mt-4 rounded-xl border p-5 ${
        isGoodNews ? "border-green-200 bg-green-50" : "border-gray-200 bg-gray-50"
      }`}
    >
      <p className={`text-sm font-medium ${isGoodNews ? "text-green-900" : "text-navy"}`}>
        {gap.headline}
      </p>
      {gap.action && (
        <p className={`mt-2 text-sm ${isGoodNews ? "text-green-800" : "text-gray-600"}`}>
          {gap.action}
        </p>
      )}
      {needsJobTypes && (
        <Link
          href="/dashboard/jobs"
          className="mt-3 inline-block text-sm font-medium text-brand hover:underline"
        >
          Set job types
        </Link>
      )}
    </div>
  );
}

export default async function IntelligencePage() {
  const account = await getAccount();
  if (!account) redirect("/login");

  // Server-side entitlement gate. An expired trial gets a proper "choose a
  // plan" screen rather than an authorization error - and because the check
  // happens here, before any financial data is loaded, a lapsed account
  // never has its numbers computed and sent to the browser either.
  const entitlements = await getEntitlements(account.ownerId);
  if (!entitlements.active) {
    return <UpgradeRequired access={entitlements.access} />;
  }

  // The company picked in the company switcher (see src/lib/account.ts).
  const { connection } = await getActiveConnection(account.ownerId);

  if (!connection) {
    return (
      <main>
        <h1 className="text-2xl font-bold text-navy">Profit Intelligence</h1>
        <p className="mt-4 text-gray-600">Connect QuickBooks from the Dashboard to see Profit Intelligence here.</p>
      </main>
    );
  }

  // Checked independently even though they're the same tier today - the two
  // sections below are meant to be able to move to different tiers later
  // without this page needing a rewrite (see entitlements.ts).
  const [opportunitiesAccess, insightsAccess] = await Promise.all([
    requireFeature(account.ownerId, "profit_opportunities"),
    requireFeature(account.ownerId, "ai_insights"),
  ]);

  const profitData = await getConnectionProfitData(connection.id, new Date());

  const insights = insightsAccess
    ? await prisma.profitInsight.findMany({
        where: { connectionId: connection.id, status: "active" },
        orderBy: { generatedAt: "desc" },
      })
    : [];
  const latestRun = insightsAccess
    ? await prisma.analysisRun.findFirst({
        where: { connectionId: connection.id, kind: "intelligence" },
        orderBy: { generatedAt: "desc" },
      })
    : null;

  const jobIds = Array.from(
    new Set([...insights.flatMap((i) => i.sourceJobIds), ...profitData.opportunities.flatMap((o) => o.supportingJobIds)])
  );
  const jobNames = jobIds.length
    ? Object.fromEntries(
        (await prisma.job.findMany({ where: { id: { in: jobIds } }, select: { id: true, name: true } })).map((j) => [
          j.id,
          j.name,
        ])
      )
    : {};

  return (
    <main>
      <h1 className="text-2xl font-bold text-navy">Profit Intelligence</h1>
      <p className="mt-2 text-sm text-gray-500">
        Cross-job patterns and AI-written recommendations, built on top of your Profit Dashboard numbers - never a
        replacement for them.
      </p>

      {/* Profit Opportunities - deterministic cross-job rollups, no AI involved */}
      <section className="mt-8">
        <h2 className="text-lg font-semibold text-navy">Profit Opportunities</h2>
        <p className="mt-1 text-xs text-gray-400">
          Patterns found by comparing your completed jobs to each other - every number here is computed directly, not
          written by AI.
        </p>
        {!opportunitiesAccess ? (
          <UpgradeNotice feature="Profit Opportunities" />
        ) : profitData.opportunities.length === 0 ? (
          <OpportunityEmptyState jobs={profitData.jobs} />
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            {profitData.opportunities.map((o, i) => (
              <div key={i} className="rounded-xl border border-gray-200 p-5">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-sm font-semibold text-navy">{o.title}</h3>
                  <ConfidenceBadge confidence={o.confidence} />
                </div>
                <p className="mt-2 text-sm text-gray-600">{o.description}</p>
                {o.financialImpact != null && (
                  <p className="mt-2 text-xs text-gray-500">Estimated impact: {formatCurrency(o.financialImpact)}</p>
                )}
                <JobLinks ids={o.supportingJobIds} names={jobNames} />
              </div>
            ))}
          </div>
        )}
      </section>

      {/* AI Analysis - explicitly labeled per the explainability requirement */}
      <section className="mt-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-navy">Profit Insights</h2>
          {insightsAccess && <RefreshAnalysisButton connectionId={connection.id} />}
        </div>
        <p className="mt-1 text-xs text-gray-400">
          {insightsAccess
            ? opportunitiesAccess
              ? "AI-written explanations and recommendations for the Profit Opportunities above. The dollar figures and job lists come from the calculations, not from the AI."
              : "AI-written explanations and recommendations for the job-level issues on your dashboard. The dollar figures come from the calculations, not from the AI. Patterns across jobs are part of Profit Intelligence Pro."
            : ""}
        </p>

        {!insightsAccess ? (
          <UpgradeNotice feature="Profit Insights" />
        ) : (
          <>
            {latestRun && (
              <p className="mt-2 text-xs text-gray-400">Last analyzed {formatDateTime(latestRun.generatedAt, connection.emailTimezone)}.</p>
            )}
            {insights.length === 0 ? (
              <p className="mt-3 text-sm text-gray-500">
                {opportunitiesAccess
                  ? "No analysis yet. Click \u201cRefresh Analysis\u201d to write findings for the Profit Opportunities above. It needs at least one pattern to work from, which usually means a few completed jobs with a job type set."
                  : "No analysis yet. Click \u201cRefresh Analysis\u201d to write findings for the job-level issues on your dashboard."}
              </p>
            ) : (
              <div className="mt-4 space-y-4">
                {insights.map((insight) => (
                  <div key={insight.id} className="rounded-xl border border-brand-light bg-blue-50/40 p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-brand">AI Analysis</p>
                        <h3 className="mt-1 text-sm font-semibold text-navy">{insight.finding}</h3>
                      </div>
                      <ConfidenceBadge confidence={insight.confidence} />
                    </div>
                    <p className="mt-2 text-sm text-gray-600">{insight.evidence}</p>
                    <p className="mt-2 text-sm text-gray-700">
                      <span className="font-medium">Recommended:</span> {insight.recommendedAction}
                    </p>
                    {insight.financialImpact != null && (
                      <p className="mt-2 text-xs text-gray-500">
                        Estimated impact: {formatCurrency(Number(insight.financialImpact))}
                      </p>
                    )}
                    <JobLinks ids={insight.sourceJobIds} names={jobNames} />
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}

function JobLinks({ ids, names }: { ids: string[]; names: Record<string, string> }) {
  if (ids.length === 0) return null;
  return (
    <p className="mt-3 text-xs text-gray-400">
      Based on: {ids.map((id, i) => (
        <span key={id}>
          {i > 0 && ", "}
          <Link href={`/dashboard/jobs/${id}`} className="text-brand hover:underline">
            {names[id] ?? "Job"}
          </Link>
        </span>
      ))}
    </p>
  );
}
