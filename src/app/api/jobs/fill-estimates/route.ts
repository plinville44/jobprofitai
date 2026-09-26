import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { connectionForAccount, getAccount } from "@/lib/account";
import { OPEN_JOB_WHERE } from "@/lib/jobStatus";

/**
 * POST /api/jobs/fill-estimates  { connectionId }
 *
 * For open jobs with a contract value and no estimated cost, sets
 *   estimated cost = contract value x (1 - target margin)
 * using the job type's target where one is set, else the company target.
 *
 * It's an assumption, and the button that calls this says so: it is the
 * budget the job would need to hit the target, not a quote. It is still far
 * better than no budget, because without one over-budget checks, over/under
 * billing and the forecast can't run at all. Existing estimates are never
 * touched.
 */
export async function POST(req: NextRequest) {
  try {
    const account = await getAccount();
    if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const connection = await connectionForAccount(account, body?.connectionId);
    if (!connection) return NextResponse.json({ error: "Company not found" }, { status: 404 });

    const targets = await prisma.marginTarget.findMany({ where: { connectionId: connection.id } });
    const byType = new Map(targets.map((t) => [t.category, Number(t.targetPct)]));
    const companyTarget = connection.targetMarginPct == null ? null : Number(connection.targetMarginPct);
    if (companyTarget == null && byType.size === 0) {
      return NextResponse.json({ error: "Set a target margin in Settings first." }, { status: 400 });
    }

    const jobs = await prisma.job.findMany({
      where: { connectionId: connection.id, estimatedCost: null, ...OPEN_JOB_WHERE },
      select: { id: true, category: true, manualContractValue: true, estimatedRevenue: true },
    });
    let updated = 0;
    let skippedNoContract = 0;
    for (const j of jobs) {
      const contract = j.manualContractValue != null ? Number(j.manualContractValue) : j.estimatedRevenue != null ? Number(j.estimatedRevenue) : null;
      if (contract == null || contract <= 0) {
        skippedNoContract++;
        continue;
      }
      const target = (j.category ? byType.get(j.category) : undefined) ?? companyTarget;
      if (target == null || target >= 100) continue;
      const estimatedCost = Math.round(contract * (1 - target / 100) * 100) / 100;
      // Marked, so the Profit Opportunity Feed never reads "costs ran over
      // estimate" off a figure that was only ever the target margin.
      await prisma.job.update({ where: { id: j.id }, data: { estimatedCost, estimatedCostSource: "target_margin" } });
      updated++;
    }
    return NextResponse.json({ ok: true, updated, skippedNoContract });
  } catch (err) {
    console.error("jobs/fill-estimates failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json({ error: "Couldn't fill estimates. Please try again." }, { status: 500 });
  }
}
