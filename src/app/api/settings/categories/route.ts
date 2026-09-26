import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { connectionForAccount, getAccount } from "@/lib/account";
import { COST_CATEGORIES } from "@/lib/qboNormalize";

/**
 * GET  /api/settings/categories?connectionId=...
 *      Every QuickBooks account or item that job costs were posted to, and
 *      every product or service on a synced estimate, with the category it
 *      currently lands in and how much money that is on each side.
 * POST /api/settings/categories { connectionId, sourceName, category | null }
 *      Maps one account or item to a category (null = back to automatic).
 *
 * The automatic mapping reads QuickBooks' account types and names, which
 * gets most charts of accounts right and some of them wrong ("Cost of Goods
 * Sold" says nothing about labor vs. materials). The contractor's own
 * choice always wins, and applies to stored costs immediately.
 */
export async function GET(req: NextRequest) {
  const account = await getAccount();
  if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const connection = await connectionForAccount(account, req.nextUrl.searchParams.get("connectionId"));
  if (!connection) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const groups = await prisma.costEntry.groupBy({
    by: ["accountName", "category"],
    // Timesheet labor is always labor (the sync writes it that way), so it
    // isn't offered for remapping.
    where: { job: { connectionId: connection.id }, accountName: { not: null }, qboSourceType: { not: "TimeActivity" } },
    _sum: { amount: true },
    _count: { _all: true },
  });
  const mappings = await prisma.categoryMapping.findMany({ where: { connectionId: connection.id } });
  const mapped = new Map(mappings.map((m) => [m.sourceName, m.category]));

  const bySource = new Map<string, { sourceName: string; category: string; amount: number; count: number }>();
  for (const g of groups) {
    const name = g.accountName as string;
    const amount = Number(g._sum.amount ?? 0);
    const prior = bySource.get(name);
    // One row per account; the category holding the most money is the one shown.
    if (!prior) bySource.set(name, { sourceName: name, category: g.category, amount, count: g._count._all });
    else {
      if (Math.abs(amount) > Math.abs(prior.amount)) prior.category = g.category;
      prior.amount += amount;
      prior.count += g._count._all;
    }
  }
  // Products and services on estimates: what customers are quoted for
  // each part of the job. Same names, same mappings, so one choice here
  // sorts both the cost and the price side.
  const estimates = await prisma.jobEstimate.findMany({ where: { connectionId: connection.id }, select: { lines: true } });
  const onEstimates = new Map<string, { category: string; amount: number }>();
  for (const e of estimates) {
    if (!Array.isArray(e.lines)) continue;
    for (const l of e.lines as { n?: unknown; c?: unknown; a?: unknown }[]) {
      if (typeof l?.n !== "string" || !l.n || typeof l.a !== "number" || typeof l.c !== "string") continue;
      const prior = onEstimates.get(l.n) ?? { category: l.c, amount: 0 };
      prior.amount += l.a;
      onEstimates.set(l.n, prior);
    }
  }
  for (const [name, est] of onEstimates) {
    if (!bySource.has(name)) bySource.set(name, { sourceName: name, category: est.category, amount: 0, count: 0 });
  }

  const rows = [...bySource.values()]
    .map((r) => ({
      ...r,
      amount: Math.round(r.amount * 100) / 100,
      estimateAmount: Math.round((onEstimates.get(r.sourceName)?.amount ?? 0) * 100) / 100,
      mapped: mapped.get(r.sourceName) ?? null,
    }))
    .sort((a, b) => Math.abs(b.amount) + Math.abs(b.estimateAmount) - (Math.abs(a.amount) + Math.abs(a.estimateAmount)));
  return NextResponse.json({ rows, categories: COST_CATEGORIES });
}

export async function POST(req: NextRequest) {
  try {
    const account = await getAccount();
    if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const connection = await connectionForAccount(account, body?.connectionId);
    if (!connection) return NextResponse.json({ error: "Company not found" }, { status: 404 });
    const sourceName = typeof body?.sourceName === "string" ? body.sourceName : "";
    if (!sourceName) return NextResponse.json({ error: "Missing account name" }, { status: 400 });

    if (body.category === null || body.category === "") {
      await prisma.categoryMapping.deleteMany({ where: { connectionId: connection.id, sourceName } });
      // Back to automatic: the next full sync re-reads it.
      await prisma.quickBooksConnection.update({ where: { id: connection.id }, data: { lastFullSyncAt: null } });
      return NextResponse.json({ ok: true, updated: 0, pendingSync: true });
    }
    if (!(COST_CATEGORIES as string[]).includes(body.category)) {
      return NextResponse.json({ error: "Invalid category" }, { status: 400 });
    }
    await prisma.categoryMapping.upsert({
      where: { connectionId_sourceName: { connectionId: connection.id, sourceName } },
      create: { connectionId: connection.id, sourceName, category: body.category },
      update: { category: body.category },
    });
    const result = await prisma.costEntry.updateMany({
      where: { job: { connectionId: connection.id }, accountName: sourceName },
      data: { category: body.category },
    });
    // The same product or service on stored estimates moves too.
    const estimates = await prisma.jobEstimate.findMany({ where: { connectionId: connection.id }, select: { id: true, lines: true } });
    let estimateLines = 0;
    for (const e of estimates) {
      if (!Array.isArray(e.lines)) continue;
      let changed = false;
      const lines = (e.lines as { n?: unknown; c?: unknown; a?: unknown }[]).map((l) => {
        if (l?.n === sourceName && l.c !== body.category) {
          changed = true;
          estimateLines++;
          return { ...l, c: body.category };
        }
        return l;
      });
      if (changed) await prisma.jobEstimate.update({ where: { id: e.id }, data: { lines: lines as object[] } });
    }
    return NextResponse.json({ ok: true, updated: result.count, estimateLines });
  } catch (err) {
    console.error("settings/categories failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json({ error: "Couldn't save that. Please try again." }, { status: 500 });
  }
}
