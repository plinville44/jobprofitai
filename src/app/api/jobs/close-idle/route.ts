import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { connectionForAccount, getAccount } from "@/lib/account";
import { OPEN_JOB_WHERE } from "@/lib/jobStatus";
import { IDLE_JOB_DAYS } from "@/lib/profitability";

/**
 * POST /api/jobs/close-idle  { connectionId }
 *
 * Marks every open job with no financial activity for IDLE_JOB_DAYS (or
 * none ever, on a QuickBooks record at least that old) as completed.
 *
 * QuickBooks' API doesn't expose a project's Completed status, so a company
 * with years of projects arrives with every one of them "active": hundreds
 * of active jobs, all of them stale, and none in the finished-job
 * comparisons. This is the one-click fix Data Health offers. It only sets
 * the contractor's own override, so any job can be reopened from its page,
 * and nothing in QuickBooks changes.
 */
export async function POST(req: NextRequest) {
  try {
    const account = await getAccount();
    if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const connection = await connectionForAccount(account, body?.connectionId);
    if (!connection) return NextResponse.json({ error: "Company not found" }, { status: 404 });

    const cutoff = new Date(Date.now() - IDLE_JOB_DAYS * 86_400_000);
    const open = await prisma.job.findMany({
      where: { connectionId: connection.id, ...OPEN_JOB_WHERE },
      select: {
        id: true,
        qboCreatedAt: true,
        createdAt: true,
        costEntries: { select: { txnDate: true }, orderBy: { txnDate: "desc" }, take: 1 },
        invoices: { select: { txnDate: true }, orderBy: { txnDate: "desc" }, take: 1 },
      },
    });
    const idle = open.filter((j) => {
      const dates = [j.costEntries[0]?.txnDate, j.invoices[0]?.txnDate].filter((d): d is Date => d != null);
      const last = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : j.qboCreatedAt;
      return last != null && last < cutoff;
    });
    if (idle.length === 0) return NextResponse.json({ ok: true, updated: 0 });

    const result = await prisma.job.updateMany({
      where: { id: { in: idle.map((j) => j.id) }, connectionId: connection.id },
      data: { statusOverride: "closed" },
    });
    return NextResponse.json({ ok: true, updated: result.count });
  } catch (err) {
    console.error("jobs/close-idle failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json({ error: "Couldn't update those jobs. Please try again." }, { status: 500 });
  }
}
