import { NextRequest, NextResponse } from "next/server";
import { connectionForAccount, getAccount } from "@/lib/account";
import { getEntitlements } from "@/lib/entitlements";
import { getConnectionProfitData } from "@/lib/profitability";
import { buildWipSchedule } from "@/lib/wipSchedule";
import { toCsv } from "@/lib/csv";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/wip/export?connectionId=...  The Work in Progress schedule as a
 * CSV, for the bookkeeper, bank or bonding company. Same figures as the WIP
 * page and the bank-ready report: one row per contract in progress, a total
 * row, then open jobs that aren't on the schedule yet and why.
 */
export async function GET(req: NextRequest) {
  const account = await getAccount();
  if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const entitlements = await getEntitlements(account.ownerId);
  if (!entitlements.active) return NextResponse.json({ error: "Your subscription isn't active." }, { status: 402 });
  const connection = await connectionForAccount(account, req.nextUrl.searchParams.get("connectionId"));
  if (!connection) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const now = new Date();
  const [data, filled] = await Promise.all([
    getConnectionProfitData(connection.id, now, { statusFilter: "open" }),
    prisma.job.findMany({ where: { connectionId: connection.id, estimatedCostSource: "target_margin" }, select: { id: true } }),
  ]);
  const schedule = buildWipSchedule(data.lifetimeJobs, now, new Set(filled.map((j) => j.id)));
  const canForecast = entitlements.has("forecast_at_completion");
  const round = (n: number | null | undefined) => (n == null ? "" : Math.round(n * 100) / 100);
  const header = [
    "Job", "Customer", "Contract value", "Estimated total cost", "Cost estimate from", "Estimated gross profit", "Cost to date",
    "Percent complete", "Percent complete from", "Earned revenue", "Billed to date", "Over billed", "Under billed",
    "Over (under) billed", "Cost to complete", "Gross profit to date",
    ...(canForecast ? ["Forecast cost at completion", "Forecast margin %"] : []),
  ];
  const rows: (string | number)[][] = schedule.inProgress.map((r) => {
    const f = data.forecasts.get(r.jobId);
    return [
      r.jobName,
      r.customerName ?? "",
      round(r.contract),
      round(r.estimatedTotalCost),
      r.estimatedTotalCost == null ? "" : r.costFromTarget ? "target margin" : "estimate",
      round(r.estimatedGrossProfit),
      round(r.costToDate),
      Math.round(r.percentComplete * 1000) / 10,
      r.percentFromEntry ? "entered" : "cost vs estimate",
      round(r.earnedRevenue),
      round(r.billedToDate),
      round(r.overBilled),
      round(r.underBilled),
      round(r.overBilled - r.underBilled),
      round(r.costToComplete),
      round(r.grossProfitToDate),
      ...(canForecast
        ? [round(f?.available ? f.forecastCostAtCompletion : null), f?.available && f.forecastMarginPct != null ? Math.round(f.forecastMarginPct * 1000) / 10 : ""]
        : []),
    ];
  });
  const t = schedule.totals;
  if (schedule.inProgress.length > 0) {
    rows.push([
      "Total", "", round(t.contract), round(t.estimatedTotalCost), "", round(t.estimatedGrossProfit), round(t.costToDate), "", "",
      round(t.earnedRevenue), round(t.billedToDate), round(t.overBilled), round(t.underBilled), round(t.overBilled - t.underBilled),
      round(t.costToComplete), round(t.grossProfitToDate), ...(canForecast ? ["", ""] : []),
    ]);
  }
  for (const j of schedule.notScheduled) {
    const row: (string | number)[] = new Array(header.length).fill("");
    row[0] = j.jobName;
    row[8] = j.needs === "contract" ? "not on schedule: needs a contract value" : "not on schedule: needs a cost estimate or percent complete";
    rows.push(row);
  }
  const name = (connection.companyName ?? "company").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return new NextResponse(toCsv([header, ...rows]), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="wip-${name}-${now.toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
