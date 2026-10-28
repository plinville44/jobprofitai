import { NextRequest, NextResponse } from "next/server";
import { localWeekStarting, isValidTimeZone } from "@/lib/schedule";
import { prisma } from "@/lib/prisma";
import { connectionForAccount, getAccount, refuseClient } from "@/lib/account";
import { tryMarkFirstAnalysis } from "@/lib/trial";
import { tryAnnounceAnalysisReady } from "@/lib/email/lifecycle";
import { jobSourceQuestionPending } from "@/lib/jobSetup";
import { getEntitlements, inactiveMessage } from "@/lib/entitlements";
import { generateWeeklyDigestForConnection, SummaryOutOfTimeError } from "@/lib/digest";
import { overLimitConnectionIds, pausedCompaniesMessage } from "@/lib/planLimits";
import { fullSyncPartway } from "@/lib/syncProblem";
import { aiFailureKind } from "@/lib/ai";
import { reportError } from "@/lib/monitoring";
import { publicErrorMessage } from "@/lib/publicError";

/**
 * POST /api/digest/generate  { connectionId }
 * Computes this week's metrics, has Claude write the narrative, and stores
 * the result. It deliberately does NOT email: that is the weekly cron's job
 * (api/cron/weekly-email), which sends on each connection's configured day
 * and hour and stamps emailedAt so a retry cannot send twice. This button
 * exists so a customer can see the current week's brief on demand without
 * waiting for, or triggering, their scheduled send.
 */
// A sync-free brief: metrics plus one AI call.
export const maxDuration = 120;

const BRIEF_COOLDOWN_MS = 60_000;

export async function POST(req: NextRequest) {
  try {
    const account = await getAccount();
    if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const refused = refuseClient(account);
    if (refused) return refused;

    // Entitlement enforced server-side. Hiding the button in the browser is
    // not a control - this route generates paid value (a QuickBooks sync, an
    // Anthropic call) and must refuse a lapsed account regardless of what
    // the client sends.
    const entitlements = await getEntitlements(account.ownerId);
    if (!entitlements.active) {
      return NextResponse.json(
        { error: inactiveMessage(entitlements), code: "entitlement_required" },
        { status: 402 }
      );
    }

    const body = await req.json().catch(() => ({}));
    // Scoped to this login's account, and a disconnected company gets no
    // new brief: the same checks Sync now makes (api/quickbooks/sync).
    const connection = await connectionForAccount(account, body?.connectionId);
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }
    // Nor does a company past the plan's company limit (src/lib/planLimits.ts):
    // it isn't synced and gets no weekly brief, so no AI brief on demand either.
    if ((await overLimitConnectionIds(account.ownerId)).has(connection.id)) {
      const name = connection.companyName?.trim() || "This company";
      return NextResponse.json(
        {
          error: `${pausedCompaniesMessage([name], entitlements.limits.maxConnections)} A paused company keeps its figures but gets no new brief. Billing shows what to do.`,
          code: "company_paused",
        },
        { status: 403 }
      );
    }
    // A full read of QuickBooks still partway leaves some data read and some
    // not: a brief now would show costs without their invoices. Not once the
    // read's last try failed: a stuck read is put off again every time, and
    // the button would refuse for good. The dashboard says the sync failed.
    if (fullSyncPartway(connection) && connection.lastSyncStatus !== "error") {
      return NextResponse.json(
        {
          error: "Your QuickBooks history is still being read, so the brief would show costs without their invoices. It's made once the read finishes, usually overnight.",
          code: "sync_partway",
        },
        { status: 409 }
      );
    }

    // One brief a minute per company. Each one is an AI call; without a
    // limit, a script could run up the bill without end.
    const claim = await prisma.quickBooksConnection.updateMany({
      where: { id: connection.id, OR: [{ aiBriefAt: null }, { aiBriefAt: { lt: new Date(Date.now() - BRIEF_COOLDOWN_MS) } }] },
      data: { aiBriefAt: new Date() },
    });
    if (claim.count === 0) {
      return NextResponse.json({ error: "A brief was just made for this company. Give it a minute and try again." }, { status: 429 });
    }

    // This week in the company's own time zone, the same key the weekly
    // send uses (see src/lib/schedule.ts).
    const timeZone = isValidTimeZone(connection.emailTimezone) ? connection.emailTimezone : "America/New_York";
    const weekStarting = localWeekStarting(new Date(), timeZone);

    const { narrative, kind, metrics } = await generateWeeklyDigestForConnection(
      connection.id,
      weekStarting,
      connection.companyName ?? "your company"
    );

    // Once this week's brief has been emailed, a preview is shown but not
    // saved over it. Next week's "What changed" compares against what was
    // stored for this week; overwriting it with a Friday preview made that
    // section skip everything between Monday's email and the preview.
    const alreadyEmailed = await prisma.weeklyDigest.findUnique({
      where: { connectionId_weekStarting: { connectionId: connection.id, weekStarting } },
      select: { id: true, emailedAt: true },
    });
    if (alreadyEmailed?.emailedAt) {
      await tryMarkFirstAnalysis(account.ownerId);
      return NextResponse.json({ id: alreadyEmailed.id, narrative, kind, preview: true });
    }

    const digest = await prisma.weeklyDigest.upsert({
      where: { connectionId_weekStarting: { connectionId: connection.id, weekStarting } },
      create: {
        connectionId: connection.id,
        weekStarting,
        metrics: metrics as any,
        narrative,
        kind,
      },
      update: {
        metrics: metrics as any,
        narrative,
        kind,
      },
    });

    // Completes trial activation the first time a customer actually gets
    // an analysis out of the product. Best-effort - a growth metric must
    // never fail the customer's real request.
    await tryMarkFirstAnalysis(account.ownerId);
    // "Your numbers are in, here's where to start." Sends once ever, guarded
    // by the EmailEvent dedupe key rather than by a check here.
    // Not held back for the "Is each job a Class?" question: it points to it.
    await tryAnnounceAnalysisReady(account.ownerId, connection.companyName, {
      jobSourceQuestionPending: jobSourceQuestionPending(connection),
    });

    return NextResponse.json({ id: digest.id, narrative, kind, metrics });
  } catch (err) {
    // Without this, an unhandled exception here returns Vercel's HTML error
    // page instead of JSON, and the dashboard button's fetch call gets stuck
    // forever trying to parse it as JSON. Always return JSON so the UI can
    // show a real error message instead of hanging.
    // Message only, never the full error object - see the matching comment
    // in api/quickbooks/sync/route.ts for why.
    console.error("digest/generate failed:", err instanceof Error ? err.message : "Unknown error");
    // A refused AI request (an old ANTHROPIC_MODEL, a revoked key) used to
    // end here unreported. A plain timeout is the wait, not a fault.
    if (!(err instanceof SummaryOutOfTimeError) && aiFailureKind(err) !== "timeout") {
      await reportError(err, { route: "/api/digest/generate", method: "POST", feature: "brief-summary" });
    }
    return NextResponse.json(
      { error: publicErrorMessage(err, "Digest generation failed.") },
      { status: 500 }
    );
  }
}
