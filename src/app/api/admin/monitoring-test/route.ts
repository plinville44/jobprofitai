import { NextResponse } from "next/server";
import { getAdminSession } from "@/lib/adminAuth";
import { parseDsn, reportError } from "@/lib/monitoring";

/**
 * GET /api/admin/monitoring-test
 *
 * Sends one test error to Sentry, so an admin can check error monitoring is
 * set up, and says whether a DSN is set and whether Sentry accepted the
 * report (its HTTP status only). Works on a preview deployment too, unlike
 * real reports, but still needs SENTRY_DSN. Changes nothing in the app.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const admin = await getAdminSession();
  if (!admin) return NextResponse.json({ error: "Not authorized" }, { status: 403 });

  const dsnSet = Boolean(process.env.SENTRY_DSN?.trim());
  const dsnValid = parseDsn(process.env.SENTRY_DSN) != null;
  const result = await reportError(
    new Error("JobProfitAI monitoring test"),
    { route: "/api/admin/monitoring-test", method: "GET", routeType: "route" },
    { anyEnvironment: true }
  );
  const status = result.sent ? result.status : null;
  return NextResponse.json({
    dsnSet,
    dsnValid,
    sent: result.sent,
    accepted: status != null && status >= 200 && status < 300,
    status,
    ...(result.sent ? {} : { reason: result.reason }),
  });
}
