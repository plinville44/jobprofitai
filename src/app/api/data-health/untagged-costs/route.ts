import { NextRequest, NextResponse } from "next/server";
import { connectionForAccount, getAccount } from "@/lib/account";
import { getEntitlements } from "@/lib/entitlements";
import { toCsv } from "@/lib/csv";
import { untaggedCsvRows } from "@/lib/untaggedCosts";
import { connectionRealmId, loadUntaggedCosts } from "@/lib/untaggedCostStore";

/**
 * GET /api/data-health/untagged-costs?connectionId=...  Every job cost from
 * the last 12 months that isn't on any job, biggest first, as a CSV, so the
 * contractor or bookkeeper can work through them in QuickBooks. Data Health
 * shows the top of the same list. Read only, so a client login may download
 * it too.
 */
export async function GET(req: NextRequest) {
  const account = await getAccount();
  if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const entitlements = await getEntitlements(account.ownerId);
  if (!entitlements.active) return NextResponse.json({ error: "Your subscription isn't active." }, { status: 402 });
  const connection = await connectionForAccount(account, req.nextUrl.searchParams.get("connectionId"));
  if (!connection) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const now = new Date();
  const { rows } = await loadUntaggedCosts(connection.id, now);
  const csv = toCsv(untaggedCsvRows(rows, connectionRealmId(connection), connection.environment));
  const name = (connection.companyName ?? "company").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="costs-not-on-a-job-${name}-${now.toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
