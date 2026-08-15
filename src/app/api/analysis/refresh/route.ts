import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { getConnectionProfitData } from "@/lib/profitability";
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
export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    const { connectionId, force } = await req.json();
    if (!connectionId || typeof connectionId !== "string") {
      return NextResponse.json({ error: "Missing connectionId" }, { status: 400 });
    }

    const connection = await prisma.quickBooksConnection.findUnique({ where: { id: connectionId } });
    if (!connection || connection.userId !== session.userId) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const latestRun = await prisma.analysisRun.findFirst({
      where: { connectionId, kind: "intelligence" },
      orderBy: { generatedAt: "desc" },
    });

    const needsRefresh =
      force === true ||
      !latestRun ||
      !connection.lastSyncedAt ||
      latestRun.dataSnapshotAt < connection.lastSyncedAt;

    if (!needsRefresh) {
      const activeCount = await prisma.profitInsight.count({ where: { connectionId, status: "active" } });
      return NextResponse.json({
        ok: true,
        refreshed: false,
        count: activeCount,
        message: "Already up to date with your latest QuickBooks sync.",
      });
    }

    const profitData = await getConnectionProfitData(connectionId, new Date());
    const drafts = await generateProfitInsights(profitData.opportunities);

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

    return NextResponse.json({ ok: true, refreshed: true, count: drafts.length });
  } catch (err) {
    console.error("analysis/refresh failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Couldn't refresh analysis." },
      { status: 500 }
    );
  }
}
