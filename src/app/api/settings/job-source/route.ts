import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { connectionForAccount, getAccount, refuseClient } from "@/lib/account";
import { refuseCrossSite } from "@/lib/sameOrigin";

/**
 * POST /api/settings/job-source  { connectionId, jobSource }
 *
 * The answer to the dashboard question shown to companies that use
 * QuickBooks Classes: are your jobs your classes, or your customers? A
 * change rebuilds the company's jobs on the next sync, the same as changing
 * it in Settings; either answer stops the question being asked again.
 */
export async function POST(req: NextRequest) {
  const refused = refuseCrossSite(req);
  if (refused) return refused;
  try {
    const account = await getAccount();
    if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const refused = refuseClient(account);
    if (refused) return refused;
    const body = await req.json().catch(() => ({}));
    const connection = await connectionForAccount(account, body?.connectionId);
    if (!connection) return NextResponse.json({ error: "Company not found" }, { status: 404 });
    const jobSource = body?.jobSource;
    if (jobSource !== "projects" && jobSource !== "customers" && jobSource !== "classes") {
      return NextResponse.json({ error: "Choose how jobs are set up in QuickBooks." }, { status: 400 });
    }
    const current = await prisma.quickBooksConnection.findUnique({ where: { id: connection.id }, select: { jobSource: true } });
    const rebuild = current?.jobSource !== jobSource;
    await prisma.quickBooksConnection.update({
      where: { id: connection.id },
      data: {
        jobSource,
        jobSourceConfirmedAt: new Date(),
        ...(rebuild ? { lastFullSyncAt: null, rebuildRequestedAt: new Date() } : {}),
      },
    });
    return NextResponse.json({ ok: true, rebuild });
  } catch (err) {
    console.error("settings/job-source failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json({ error: "Couldn't save that. Please try again." }, { status: 500 });
  }
}
