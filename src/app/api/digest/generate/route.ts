import { NextRequest, NextResponse } from "next/server";
import { localWeekStarting, isValidTimeZone } from "@/lib/schedule";
import { prisma } from "@/lib/prisma";
import { getAccount } from "@/lib/account";
import { tryMarkFirstAnalysis } from "@/lib/trial";
import { tryAnnounceAnalysisReady } from "@/lib/email/lifecycle";
import { getEntitlements, inactiveMessage } from "@/lib/entitlements";
import { generateWeeklyDigestForConnection } from "@/lib/digest";

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

export async function POST(req: NextRequest) {
  try {
    const account = await getAccount();
    if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

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

    const { connectionId } = await req.json();
    const connection = await prisma.quickBooksConnection.findUnique({
      where: { id: connectionId },
    });
    if (!connection || connection.userId !== account.ownerId) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
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
    await tryAnnounceAnalysisReady(account.ownerId, connection.companyName);

    return NextResponse.json({ id: digest.id, narrative, kind, metrics });
  } catch (err) {
    // Without this, an unhandled exception here returns Vercel's HTML error
    // page instead of JSON, and the dashboard button's fetch call gets stuck
    // forever trying to parse it as JSON. Always return JSON so the UI can
    // show a real error message instead of hanging.
    // Message only, never the full error object - see the matching comment
    // in api/quickbooks/sync/route.ts for why.
    console.error("digest/generate failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Digest generation failed." },
      { status: 500 }
    );
  }
}
