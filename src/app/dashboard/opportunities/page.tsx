import { redirect } from "next/navigation";
import Link from "next/link";
import { getAccount, getActiveConnection } from "@/lib/account";
import { prisma } from "@/lib/prisma";
import { getEntitlements } from "@/lib/entitlements";
import UpgradeRequired from "@/components/dashboard/UpgradeRequired";
import { getOpportunityData, getTrackedActions } from "@/lib/opportunityData";
import { formatCurrency, formatDateTime } from "@/lib/format";
import { ConfidenceBadge } from "@/components/dashboard/Badges";
import OpportunitySummary from "@/components/opportunities/OpportunitySummary";
import FeedItemCard from "@/components/opportunities/FeedItemCard";
import TrackedChanges from "@/components/opportunities/TrackedChanges";
import RefreshAnalysisButton from "../intelligence/RefreshAnalysisButton";
import type { FeedItem } from "@/lib/opportunities";

export const metadata = { title: "Profit Opportunities" };

const trackKey = (kind: string, subjectKey: string, costCategory: string | null) => `${kind}|${subjectKey}|${costCategory ?? ""}`;

/**
 * The Profit Opportunity Feed: what to change to make more money, worked out
 * from the contractor's own QuickBooks jobs, each with what it's worth, the
 * evidence, what to do and how the figure was reached. Then the changes
 * they're tracking, then the AI advisor notes, which are written from the
 * same figures and never change them.
 */
export default async function OpportunitiesPage() {
  const account = await getAccount();
  if (!account) redirect("/login");
  const entitlements = await getEntitlements(account.ownerId);
  if (!entitlements.active) return <UpgradeRequired access={entitlements.access} />;

  const { connection } = await getActiveConnection(account.ownerId);
  if (!connection) {
    return (
      <main>
        <h1 className="text-2xl font-bold text-navy">Profit Opportunities</h1>
        <p className="mt-4 text-gray-600">Connect QuickBooks from the Dashboard to see your profit opportunities here.</p>
      </main>
    );
  }

  const canSee = entitlements.has("profit_opportunities");
  if (!canSee) {
    return (
      <main>
        <h1 className="text-2xl font-bold text-navy">Profit Opportunities</h1>
        <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-6 text-sm text-gray-600">
          Profit Opportunities aren&apos;t part of your plan.{" "}
          <Link href="/dashboard/billing" className="font-medium text-brand hover:underline">
            See plans
          </Link>
          .
        </div>
      </main>
    );
  }

  const data = await getOpportunityData(connection.id);
  const tracked = await getTrackedActions(connection.id, data);
  const { feed } = data;
  const liveTracked = new Set(tracked.filter((t) => !t.stoppedAt).map((t) => trackKey(t.kind, t.subjectKey, t.costCategory)));
  const jobNames = Object.fromEntries(data.jobs.map((j) => [j.jobId, j.jobName]));

  const insightsAccess = entitlements.has("ai_insights");
  const [insights, latestRun] = insightsAccess
    ? await Promise.all([
        prisma.profitInsight.findMany({ where: { connectionId: connection.id, status: "active" }, orderBy: { generatedAt: "desc" } }),
        prisma.analysisRun.findFirst({ where: { connectionId: connection.id, kind: "intelligence" }, orderBy: { generatedAt: "desc" } }),
      ])
    : [[], null];

  const section = (s: FeedItem["section"]) => feed.items.filter((i) => i.section === s);
  const card = (item: FeedItem) => (
    <FeedItemCard
      key={item.id}
      item={item}
      jobNames={jobNames}
      connectionId={connection.id}
      canTrack
      tracked={item.trackable ? liveTracked.has(trackKey(item.trackable.kind, item.trackable.subjectKey, item.trackable.costCategory)) : false}
    />
  );
  const actNow = section("act_now");
  const pricing = section("pricing");
  const working = section("working");

  return (
    <main>
      <h1 className="text-2xl font-bold text-navy">Profit Opportunities</h1>
      <p className="mt-2 max-w-3xl text-sm text-gray-600">
        QuickBooks shows how your jobs did. This page shows what to change to make more on the next ones, and what
        each change is worth, worked out from your own finished jobs and your target margins.
      </p>

      <div className="mt-6">
        <OpportunitySummary summary={feed.summary} />
      </div>

      {feed.setup.length > 0 && (
        <div className="mt-4 space-y-2">
          {feed.setup.map((h) => (
            <p key={h.code} className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700">
              {h.message}{" "}
              <Link href={h.href} className="font-semibold text-brand hover:underline">
                {h.linkText}
              </Link>
            </p>
          ))}
        </div>
      )}

      <section className="mt-10">
        <h2 className="text-lg font-semibold text-navy">Act now</h2>
        <p className="mt-1 text-xs text-gray-500">Estimates you can still change, open jobs you can still steer, and bills you can still send.</p>
        {actNow.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500">Nothing urgent: no pending estimate below target, no open job heading below it, and billing is keeping up.</p>
        ) : (
          <div className="mt-4 space-y-4">{actNow.map(card)}</div>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold text-navy">Fix your pricing</h2>
        <p className="mt-1 text-xs text-gray-500">
          Patterns in the jobs you finished over the last 12 months. One job can show up under its type, its size and
          its customer, so these figures overlap and aren&apos;t added together.
        </p>
        {pricing.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500">
            {feed.finishedJobsConsidered < 3
              ? "Pricing patterns need at least three finished jobs from the last 12 months with revenue and costs."
              : "No pricing pattern worth acting on: no job type, customer, job size or part of the price is consistently below your target."}
          </p>
        ) : (
          <div className="mt-4 space-y-4">{pricing.map(card)}</div>
        )}
      </section>

      {working.length > 0 && (
        <section className="mt-10">
          <h2 className="text-lg font-semibold text-navy">What&apos;s working</h2>
          <div className="mt-4 space-y-4">{working.map(card)}</div>
        </section>
      )}

      <section className="mt-10" id="tracking">
        <h2 className="text-lg font-semibold text-navy">Changes you&apos;re tracking</h2>
        <TrackedChanges actions={tracked} jobNames={jobNames} />
      </section>

      {insightsAccess && (
        <section className="mt-10">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-navy">Advisor notes</h2>
            <RefreshAnalysisButton connectionId={connection.id} />
          </div>
          <p className="mt-1 text-xs text-gray-500">
            Written by AI from the opportunities above, as an experienced advisor would talk them through. The dollar
            figures and jobs come from the calculations, not from the AI.
            {latestRun ? ` Last written ${formatDateTime(latestRun.generatedAt, connection.emailTimezone)}.` : ""}
          </p>
          {insights.length === 0 ? (
            <p className="mt-3 text-sm text-gray-500">No notes yet. Click Refresh Analysis to have them written.</p>
          ) : (
            <div className="mt-4 space-y-4">
              {insights.map((insight) => (
                <div key={insight.id} className="rounded-xl border border-brand-light bg-blue-50/40 p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-brand">Advisor note (AI)</p>
                      <h3 className="mt-1 text-sm font-semibold text-navy">{insight.finding}</h3>
                    </div>
                    <ConfidenceBadge confidence={insight.confidence} />
                  </div>
                  <p className="mt-2 text-sm text-gray-600">{insight.evidence}</p>
                  <p className="mt-2 text-sm text-gray-700">
                    <span className="font-medium">Recommended:</span> {insight.recommendedAction}
                  </p>
                  {insight.financialImpact != null && (
                    <p className="mt-2 text-xs text-gray-500">Worth: {formatCurrency(Number(insight.financialImpact))}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <p className="mt-10 border-t border-gray-200 pt-6 text-xs text-gray-400">
        Every dollar figure here is calculated from your QuickBooks data and your target margins. &ldquo;More profit a
        year&rdquo; is what pricing the same work at your target would have added over the last 12 months; it assumes the
        same costs and that customers would still have bought.
      </p>
    </main>
  );
}
