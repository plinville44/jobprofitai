import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccount } from "@/lib/account";
import { tryMarkFirstAnalysis } from "@/lib/trial";
import { tryAnnounceAnalysisReady } from "@/lib/email/lifecycle";
import { getEntitlements, inactiveMessage } from "@/lib/entitlements";
import { getConnectionProfitData, type ProfitOpportunity } from "@/lib/profitability";
import { generateProfitInsights } from "@/lib/intelligence";

/**
 * POST /api/analysis/refresh  { connectionId }
 *
 * Deliberately separate from /api/quickbooks/sync - "Refresh QuickBooks
 * Data" (pull new numbers from QuickBooks) and "Refresh Analysis" (re-run
 * Profit Intelligence against whatever's already synced) are different
 * operations. This route never calls QuickBooks itself.
 *
 * The deterministic Profit Opportunities are recomputed live on every visit
 * to /dashboard/intelligence anyway (same as every other page - see
 * getConnectionProfitData), so there's nothing to "refresh" there. What this
 * route actually gates is the AI call: it only re-invokes
 * generateProfitInsights when the data has actually changed since the last
 * run (AnalysisRun.dataSnapshotAt older than the connection's last sync) -
 * otherwise it's a no-op that reports the existing insights are current.
 * This is the "don't unnecessarily call AI" requirement from the plan.
 */
// Metrics plus one AI call.
export const maxDuration = 120;

/** At most this many insight cards per refresh: the ones with the most money on them. */
const MAX_INSIGHTS = 8;
/** Data-gap items. Real, and listed on the dashboard, but not worth an AI card each. */
const SETUP_ISSUES = new Set(["no_estimate_on_file", "stale_job", "revenue_no_costs"]);

/**
 * What the AI writes about. On the $149 plan this is the account's own
 * Needs Attention items, and it used to be all of them: one "no cost
 * estimate" per job, across every job ever. The model had to return one
 * card per item within a fixed length, so any real account ran past it,
 * the reply was cut off mid-JSON and the refresh failed. Trials use the Pro
 * path, so this only ever broke after someone paid.
 *
 * Now: setup gaps are left to the dashboard, the rest are ranked by dollar
 * impact then severity, and the top MAX_INSIGHTS are written up.
 */
function selectInsightSource(items: (ProfitOpportunity & { severity?: string })[]): ProfitOpportunity[] {
  const rank = (s?: string) => (s === "high" ? 3 : s === "medium" ? 2 : s === "low" ? 1 : 0);
  return items
    .filter((i) => !SETUP_ISSUES.has(i.type))
    .sort((a, b) => (b.financialImpact ?? 0) - (a.financialImpact ?? 0) || rank(b.severity) - rank(a.severity))
    .slice(0, MAX_INSIGHTS)
    .map(({ severity: _severity, ...rest }) => rest);
}

export async function POST(req: NextRequest) {
  try {
    const account = await getAccount();
    if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    // Entitlement enforced server-side. Hiding the button in the browser is
    // not a control - this route generates paid value (a QuickBooks sync, an
    // Anthropic call) and must refuse a lapsed account regardless of what
    // the client sends.
    const entitlements = await getEntitlements(account.ownerId);
    if (!entitlements.active) {
      return NextResponse.json(
        { error: inactiveMessage(entitlements), code: "entitlement_required" },
        { status: 402 }
      );
    }

    const { connectionId, force } = await req.json();
    if (!connectionId || typeof connectionId !== "string") {
      return NextResponse.json({ error: "Missing connectionId" }, { status: 400 });
    }

    const connection = await prisma.quickBooksConnection.findUnique({ where: { id: connectionId } });
    if (!connection || connection.userId !== account.ownerId) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const latestRun = await prisma.analysisRun.findFirst({
      where: { connectionId, kind: "intelligence" },
      orderBy: { generatedAt: "desc" },
    });

    // What the insights are written FROM depends on the plan, and this is
    // where the plan boundary is actually enforced.
    //
    // Company-wide pattern findings are a Pro feature. Insights used to be
    // generated from them for every plan, so a $149 account saw the Profit
    // Opportunities section locked and, directly beneath it, AI cards that
    // restated those same findings with their titles, dollar impacts and job
    // lists. Now: Pro insights come from the company-wide patterns, and $149
    // insights from that account's own job-level issues (the Needs Your
    // Attention list), which the $149 plan does include.
    const profitData = await getConnectionProfitData(connectionId, new Date());
    const canSeePatterns = entitlements.has("profit_opportunities");
    const source: ProfitOpportunity[] = selectInsightSource(
      canSeePatterns
        ? profitData.opportunities
        : profitData.needsAttention.map((item) => ({
            type: item.issueCode,
            title: `${item.jobName}: ${item.issue}`,
            description: item.issue,
            financialImpact: item.financialImpact,
            confidence: item.confidence,
            supportingJobIds: [item.jobId],
            severity: item.severity,
          }))
    );

    // Refresh when the findings themselves have changed, not only when
    // QuickBooks has synced. Marking jobs completed or setting job types
    // changes the findings without touching lastSyncedAt, and the button
    // used to answer "Already up to date" while a new pattern sat on the
    // same page with no insight written for it.
    const fingerprint = (rows: { title: string; impact: number | null }[]) =>
      rows
        .map((r) => `${r.title}|${r.impact == null ? "" : Math.round(r.impact)}`)
        .sort()
        .join("\n");
    const stored = await prisma.profitInsight.findMany({
      where: { connectionId, status: "active" },
      select: { finding: true, financialImpact: true },
    });
    const findingsChanged =
      fingerprint(source.map((o) => ({ title: o.title, impact: o.financialImpact }))) !==
      fingerprint(
        stored.map((r) => ({
          title: r.finding,
          impact: r.financialImpact == null ? null : Number(r.financialImpact),
        }))
      );

    const needsRefresh =
      force === true ||
      !latestRun ||
      !connection.lastSyncedAt ||
      latestRun.dataSnapshotAt < connection.lastSyncedAt ||
      findingsChanged;

    if (!needsRefresh) {
      const activeCount = await prisma.profitInsight.count({ where: { connectionId, status: "active" } });
      return NextResponse.json({
        ok: true,
        refreshed: false,
        count: activeCount,
        message: "Already up to date with your latest QuickBooks sync.",
      });
    }

    const drafts = await generateProfitInsights(source, canSeePatterns ? "job_category" : "job");

    await prisma.$transaction([
      // Insights are regenerated wholesale from the current opportunity set
      // each refresh, not incrementally merged - there's no per-insight
      // "dismiss" UI yet (flagged as a fast-follow), so nothing is lost by
      // replacing the set outright.
      prisma.profitInsight.deleteMany({ where: { connectionId } }),
      ...(drafts.length > 0
        ? [
            prisma.profitInsight.createMany({
              data: drafts.map((d) => ({
                connectionId,
                dimension: d.dimension,
                finding: d.finding,
                evidence: d.evidence,
                financialImpact: d.financialImpact,
                recommendedAction: d.recommendedAction,
                confidence: d.confidence,
                sourceJobIds: d.sourceJobIds,
              })),
            }),
          ]
        : []),
      prisma.analysisRun.create({
        data: { connectionId, dataSnapshotAt: connection.lastSyncedAt ?? new Date(), kind: "intelligence" },
      }),
    ]);

    await tryMarkFirstAnalysis(account.ownerId);
    // "Your numbers are in, here's where to start." Sends once ever, guarded
    // by the EmailEvent dedupe key rather than by a check here.
    await tryAnnounceAnalysisReady(account.ownerId, connection.companyName);

    return NextResponse.json({ ok: true, refreshed: true, count: drafts.length });
  } catch (err) {
    console.error("analysis/refresh failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Couldn't refresh analysis." },
      { status: 500 }
    );
  }
}
