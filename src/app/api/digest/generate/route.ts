import { NextRequest, NextResponse } from "next/server";
import { startOfWeek } from "date-fns";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { tryMarkFirstAnalysis } from "@/lib/trial";
import { tryAnnounceAnalysisReady } from "@/lib/email/lifecycle";
import { getEntitlements } from "@/lib/entitlements";
import { generateWeeklyDigestForConnection } from "@/lib/digest";

/**
 * POST /api/digest/generate  { connectionId }
 * Computes this week's metrics, has Claude write the narrative, and stores
 * the result. Sending the email (Resend) is wired in Week 2 once the sending
 * domain's SPF/DKIM/DMARC are in place - see the Week 2 plan.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    // Entitlement enforced server-side. Hiding the button in the browser is
    // not a control - this route generates paid value (a QuickBooks sync, an
    // Anthropic call) and must refuse a lapsed account regardless of what
    // the client sends.
    const entitlements = await getEntitlements(session.userId);
    if (!entitlements.active) {
      return NextResponse.json(
        {
          error:
            "Your JobProfitAI trial has ended. Choose a plan to continue.",
          code: "entitlement_required",
        },
        { status: 402 }
      );
    }

    const { connectionId } = await req.json();
    const connection = await prisma.quickBooksConnection.findUnique({
      where: { id: connectionId },
    });
    if (!connection || connection.userId !== session.userId) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const weekStarting = startOfWeek(new Date(), { weekStartsOn: 1 }); // Monday

    const { narrative, kind, metrics } = await generateWeeklyDigestForConnection(
      connection.id,
      weekStarting,
      connection.companyName ?? "your company"
    );

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
    await tryMarkFirstAnalysis(session.userId);
    // "Your numbers are in, here's where to start." Sends once ever, guarded
    // by the EmailEvent dedupe key rather than by a check here.
    await tryAnnounceAnalysisReady(session.userId, connection.companyName);

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
