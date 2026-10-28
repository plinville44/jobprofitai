import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canSeeConnection, getAccount } from "@/lib/account";
import { getEntitlements, inactiveMessage } from "@/lib/entitlements";
import { overLimitConnectionIds, pausedCompaniesMessage } from "@/lib/planLimits";
import { qboProfitAndLossForCustomer } from "@/lib/quickbooks";
import { withAccessToken } from "@/lib/quickbooksSync";
import { compareWithQuickBooks, parseProfitAndLoss } from "@/lib/qboCheck";
import { laborBurdenOf } from "@/lib/profitability";
import { publicErrorMessage } from "@/lib/publicError";

// A token refresh and a QuickBooks report, each with its own time limit
// (src/lib/quickbooks.ts: up to 30 and 46 seconds), fit inside this.
export const maxDuration = 90;

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
  if (!entitlements.active) {
    return NextResponse.json({ error: inactiveMessage(entitlements), code: "entitlement_required" }, { status: 402 });
  }

  const job = await prisma.job.findUnique({ where: { id: jobId }, include: { connection: true } });
  if (!job || !canSeeConnection(account, job.connection) || job.connection.disconnectedAt) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  // A company past the plan's company limit keeps the figures it has, but
  // QuickBooks isn't read for it (src/lib/planLimits.ts), as with sync.
  // This read it live anyway (audit Oct 27, B9).
  if ((await overLimitConnectionIds(account.ownerId)).has(job.connectionId)) {
    const name = job.connection.companyName?.trim() || "This company";
    return NextResponse.json(
      {
        error: `${pausedCompaniesMessage([name], entitlements.limits.maxConnections)} A paused company keeps its figures but isn't checked against QuickBooks. Billing shows what to do.`,
        code: "company_paused",
      },
      { status: 403 }
    );
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
      // A job from a QuickBooks Class is stored as "class:<id>"; its
      // Profit and Loss is filtered by that class, not by a customer.
      job.qboId.startsWith("class:")
        ? qboProfitAndLossForCustomer(realmId, token, job.qboId.slice("class:".length), "2000-01-01", today, "class")
        : qboProfitAndLossForCustomer(realmId, token, job.qboId, "2000-01-01", today)
    );
  } catch (err) {
    const message = publicErrorMessage(err, "QuickBooks didn't answer.");
    return NextResponse.json({ error: message }, { status: 502 });
  }
  const qb = parseProfitAndLoss(report);
  if (!qb) return NextResponse.json({ error: "QuickBooks sent a report we couldn't read." }, { status: 502 });

  const result = compareWithQuickBooks(
    {
      revenue: Number(revenue._sum.amount ?? 0),
      postedCosts,
      timesheetLabor,
      parentCustomerCosts,
      laborBurden: laborBurdenOf(job.connection),
      byClass: job.qboId.startsWith("class:"),
    },
    qb
  );
  return NextResponse.json({
    ...result,
    lastSyncedAt: job.connection.lastSyncedAt?.toISOString() ?? null,
  });
}
