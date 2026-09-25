import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccount } from "@/lib/account";
import { getEntitlements } from "@/lib/entitlements";
import { qboProfitAndLossForCustomer } from "@/lib/quickbooks";
import { withAccessToken } from "@/lib/quickbooksSync";
import { compareWithQuickBooks, parseProfitAndLoss } from "@/lib/qboCheck";

export const maxDuration = 30;

/**
 * GET /api/jobs/:jobId/quickbooks-check
 *
 * This job's revenue and posted costs here beside QuickBooks' own Profit
 * and Loss for the same customer or project (see src/lib/qboCheck.ts).
 * Reads one report from QuickBooks; changes nothing.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const account = await getAccount();
  if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const entitlements = await getEntitlements(account.ownerId);
  if (!entitlements.active) return NextResponse.json({ error: "Choose a plan to use this." }, { status: 402 });

  const job = await prisma.job.findUnique({ where: { id: jobId }, include: { connection: true } });
  if (!job || job.connection.userId !== account.ownerId || job.connection.disconnectedAt) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const [revenue, costs] = await Promise.all([
    prisma.invoiceSummary.aggregate({ where: { jobId }, _sum: { amount: true } }),
    prisma.costEntry.groupBy({
      by: ["qboSourceType", "attributionMethod"],
      where: { jobId },
      _sum: { amount: true },
    }),
  ]);
  let postedCosts = 0;
  let timesheetLabor = 0;
  let parentCustomerCosts = 0;
  for (const g of costs) {
    const amount = Number(g._sum.amount ?? 0);
    if (g.qboSourceType === "TimeActivity") timesheetLabor += amount;
    else if (g.attributionMethod !== "direct") parentCustomerCosts += amount;
    else postedCosts += amount;
  }

  // QuickBooks' report stops at "today" in UTC terms; far enough back to
  // cover any job's history.
  const today = new Date().toISOString().slice(0, 10);
  let report;
  try {
    report = await withAccessToken(job.connectionId, (realmId, token) =>
      qboProfitAndLossForCustomer(realmId, token, job.qboId, "2000-01-01", today)
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "QuickBooks didn't answer.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
  const qb = parseProfitAndLoss(report);
  if (!qb) return NextResponse.json({ error: "QuickBooks sent a report we couldn't read." }, { status: 502 });

  const result = compareWithQuickBooks(
    { revenue: Number(revenue._sum.amount ?? 0), postedCosts, timesheetLabor, parentCustomerCosts },
    qb
  );
  return NextResponse.json({
    ...result,
    lastSyncedAt: job.connection.lastSyncedAt?.toISOString() ?? null,
  });
}
