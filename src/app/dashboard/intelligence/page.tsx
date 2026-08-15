import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireFeature } from "@/lib/entitlements";
import { getConnectionProfitData } from "@/lib/profitability";
import { formatCurrency } from "@/lib/format";
import { ConfidenceBadge } from "@/components/dashboard/Badges";
import RefreshAnalysisButton from "./RefreshAnalysisButton";

function UpgradeNotice({ feature }: { feature: string }) {
  return (
    <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-6 text-sm text-gray-600">
      {feature} is part of Profit Intelligence.{" "}
      <Link href="/dashboard/settings" className="text-brand hover:underline">
        See your plan in Settings.
      </Link>
    </div>
  );
}

export default async function IntelligencePage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const connection = await prisma.quickBooksConnection.findFirst({
    where: { userId: session.userId, disconnectedAt: null },
    orderBy: { connectedAt: "desc" },
  });

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
    requireFeature(session.userId, "profit_opportunities"),
    requireFeature(session.userId, "ai_insights"),
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
          <p className="mt-3 text-sm text-gray-500">
            Not enough completed jobs yet to detect a pattern (most rules need at least 3 completed jobs in the same
            category).
          </p>
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
            ? "AI-written findings and recommendations, grounded only in the Profit Opportunities above - Claude never sees or calculates a raw number here."
            : ""}
        </p>

        {!insightsAccess ? (
          <UpgradeNotice feature="Profit Insights" />
        ) : (
          <>
            {latestRun && (
              <p className="mt-2 text-xs text-gray-400">Last analyzed {latestRun.generatedAt.toLocaleString()}.</p>
            )}
            {insights.length === 0 ? (
              <p className="mt-3 text-sm text-gray-500">
                No analysis yet. Click "Refresh Analysis" once you have a few completed jobs synced to generate
                AI-written findings from your Profit Opportunities.
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
