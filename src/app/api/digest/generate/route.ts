import { NextRequest, NextResponse } from "next/server";
import { startOfWeek } from "date-fns";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { computeConnectionMetrics } from "@/lib/profitability";
import { generateWeeklyDigest } from "@/lib/digest";

/**
 * POST /api/digest/generate  { connectionId }
 * Computes this week's metrics, has Claude write the narrative, and stores
 * the result. Sending the email (Resend) is wired in Week 2 once the sending
 * domain's SPF/DKIM/DMARC are in place - see the Week 2 plan.
 */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { connectionId } = await req.json();
  const connection = await prisma.quickBooksConnection.findUnique({
    where: { id: connectionId },
  });
  if (!connection || connection.userId !== session.userId) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  const weekStarting = startOfWeek(new Date(), { weekStartsOn: 1 }); // Monday

  const metrics = await computeConnectionMetrics(connection.id, weekStarting);
  const narrative = await generateWeeklyDigest(
    metrics,
    connection.companyName ?? "your company"
  );

  const digest = await prisma.weeklyDigest.upsert({
    where: { connectionId_weekStarting: { connectionId: connection.id, weekStarting } },
    create: {
      connectionId: connection.id,
      weekStarting,
      metrics: metrics as any,
      narrative,
    },
    update: {
      metrics: metrics as any,
      narrative,
    },
  });

  return NextResponse.json({ id: digest.id, narrative, metrics });
}
