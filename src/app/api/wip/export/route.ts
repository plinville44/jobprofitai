import { NextRequest, NextResponse } from "next/server";
import { connectionForAccount, getAccount } from "@/lib/account";
import { getEntitlements } from "@/lib/entitlements";
import { getConnectionProfitData } from "@/lib/profitability";
import { toCsv } from "@/lib/csv";

/** GET /api/wip/export?connectionId=...  The Work in Progress report as a CSV, for the bookkeeper. */
export async function GET(req: NextRequest) {
  const account = await getAccount();
  if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const entitlements = await getEntitlements(account.ownerId);
  if (!entitlements.active) return NextResponse.json({ error: "Your subscription isn't active." }, { status: 402 });
  const connection = await connectionForAccount(account, req.nextUrl.searchParams.get("connectionId"));
  if (!connection) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const data = await getConnectionProfitData(connection.id, new Date(), { statusFilter: "open" });
  const canForecast = entitlements.has("forecast_at_completion");
  const round = (n: number | null | undefined) => (n == null ? "" : Math.round(n * 100) / 100);
  const header = [
    "Job", "Customer", "Contract value", "Estimated cost", "Cost to date", "Percent complete", "Percent complete from",
    "Earned revenue", "Billed to date", "Over (under) billed", ...(canForecast ? ["Forecast cost at completion", "Forecast margin %"] : []),
  ];
  const rows = data.jobs
    .filter((j) => j.status === "open")
    .sort((a, b) => a.jobName.localeCompare(b.jobName))
    .map((j) => {
      const f = data.forecasts.get(j.jobId);
      return [
        j.jobName,
        j.customerName ?? "",
        round(j.estimatedRevenue),
        round(j.estimatedCost),
        round(j.costs),
        j.wip ? Math.round(j.wip.percentComplete * 1000) / 10 : "",
        j.wip ? (j.wip.percentCompleteSource === "manual" ? "entered" : "cost vs estimate") : "",
        round(j.wip?.earnedRevenue),
        round(j.revenue),
        round(j.wip?.overUnderBilling),
        ...(canForecast
          ? [round(f?.available ? f.forecastCostAtCompletion : null), f?.available && f.forecastMarginPct != null ? Math.round(f.forecastMarginPct * 1000) / 10 : ""]
          : []),
      ];
    });
  const name = (connection.companyName ?? "company").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return new NextResponse(toCsv([header, ...rows]), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="wip-${name}-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
