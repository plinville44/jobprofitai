import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccount } from "@/lib/account";
import { getEntitlements, inactiveMessage } from "@/lib/entitlements";
import { refuseCrossSite } from "@/lib/sameOrigin";
import { getOpportunityData } from "@/lib/opportunityData";

/**
 * POST /api/opportunities/track  { connectionId, itemId }
 *
 * "I'm making this change": records the pricing change behind a Profit
 * Opportunity and the baseline it will be measured against.
 *
 * The browser only names the item. The baseline is recomputed here from the
 * synced data, so what gets stored is the number the page showed, and a
 * request can't plant a flattering baseline.
 */
export async function POST(req: NextRequest) {
  const refused = refuseCrossSite(req);
  if (refused) return refused;
  try {
    const account = await getAccount();
    if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const entitlements = await getEntitlements(account.ownerId);
    if (!entitlements.active) return NextResponse.json({ error: inactiveMessage(entitlements) }, { status: 402 });
    if (!entitlements.has("profit_opportunities")) {
      return NextResponse.json({ error: "Your plan doesn't include Profit Opportunities." }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const connectionId = typeof body?.connectionId === "string" ? body.connectionId : null;
    const itemId = typeof body?.itemId === "string" ? body.itemId.slice(0, 300) : null;
    if (!connectionId || !itemId) return NextResponse.json({ error: "Missing connectionId or itemId." }, { status: 400 });

    const connection = await prisma.quickBooksConnection.findFirst({
      where: { id: connectionId, userId: account.ownerId, disconnectedAt: null },
      select: { id: true },
    });
    if (!connection) return NextResponse.json({ error: "QuickBooks company not found." }, { status: 404 });

    const { feed } = await getOpportunityData(connection.id);
    const item = feed.items.find((i) => i.id === itemId);
    if (!item?.trackable) {
      return NextResponse.json(
        { error: "That opportunity has changed since the page loaded. Refresh the page and try again." },
        { status: 409 }
      );
    }
    const t = item.trackable;

    // One live tracking per change: tracking it again restarts nothing.
    const existing = await prisma.profitAction.findFirst({
      where: { connectionId: connection.id, kind: t.kind, subjectKey: t.subjectKey, costCategory: t.costCategory, stoppedAt: null },
      select: { id: true },
    });
    if (existing) return NextResponse.json({ ok: true, id: existing.id, alreadyTracking: true });

    const created = await prisma.profitAction.create({
      data: {
        connectionId: connection.id,
        kind: t.kind,
        subjectKey: t.subjectKey,
        costCategory: t.costCategory,
        title: item.title.slice(0, 500),
        action: item.action.slice(0, 2000),
        // Decimal(7,4): a group costing far more than it billed (a small
        // deposit invoice on a big job) would overflow it, so it's clamped.
        baselineMarginPct: Math.round(Math.max(-99, Math.min(0.9999, t.baselineMarginPct)) * 10_000) / 10_000,
        baselineJobs: t.baselineJobs,
        baselineRevenue: Math.round(t.baselineRevenue * 100) / 100,
        targetMarginPct: t.targetMarginPct == null ? null : Math.round(t.targetMarginPct * 100) / 100,
        createdByUserId: account.userId,
      },
      select: { id: true },
    });
    return NextResponse.json({ ok: true, id: created.id });
  } catch (err) {
    console.error("opportunities/track failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json({ error: "Couldn't save that. Please try again." }, { status: 500 });
  }
}
