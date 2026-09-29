import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { connectionForAccount, getAccount, refuseClient } from "@/lib/account";
import { refuseCrossSite } from "@/lib/sameOrigin";
import { decideJobSourceAnswer, jobSetupChangeData, parseJobSourceAnswer } from "@/lib/jobSetup";

/**
 * POST /api/settings/job-source  { connectionId, jobSource: "classes" | "keep" }
 *
 * The answer to the dashboard question shown to companies that use
 * QuickBooks Classes: are your jobs your classes, or your customers?
 *
 * "keep" is decided here against the setting stored now, not the one the
 * page loaded with: the first sync can move a company to one customer per
 * job, and sending back the page's old value undid that. Either answer is
 * recorded as confirmed, which stops the question being asked again and
 * stops a first sync from changing the setting.
 *
 * A change rebuilds the company's jobs on the next full sync (the dashboard
 * starts one straight away), resets the alert baseline so the new job rows
 * aren't emailed as new alerts, and marks the date the figures' basis changed.
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
    const answer = parseJobSourceAnswer(body?.jobSource);
    if (!answer) {
      return NextResponse.json({ error: "Choose how jobs are set up in QuickBooks." }, { status: 400 });
    }
    const current = await prisma.quickBooksConnection.findUnique({ where: { id: connection.id }, select: { jobSource: true } });
    const decision = decideJobSourceAnswer(current?.jobSource, answer);
    if (!decision.ok) return NextResponse.json({ error: decision.error }, { status: decision.status });

    const now = new Date();
    if (decision.rebuild) {
      await prisma.quickBooksConnection.update({
        where: { id: connection.id },
        data: { jobSource: decision.jobSource, jobSourceConfirmedAt: now, ...jobSetupChangeData(now) },
      });
    } else {
      // Only the confirmation is written, never the setting: whatever is
      // stored at this moment is what "keep" keeps.
      await prisma.quickBooksConnection.update({ where: { id: connection.id }, data: { jobSourceConfirmedAt: now } });
    }
    return NextResponse.json({ ok: true, rebuild: decision.rebuild, jobSource: decision.jobSource });
  } catch (err) {
    console.error("settings/job-source failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json({ error: "Couldn't save that. Please try again." }, { status: 500 });
  }
}
