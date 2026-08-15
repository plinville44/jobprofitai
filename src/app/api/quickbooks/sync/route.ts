import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { runSyncForConnection } from "@/lib/quickbooksSync";

/**
 * POST /api/quickbooks/sync  { connectionId }
 *
 * Thin HTTP wrapper: checks who's asking (session + connection ownership),
 * then delegates the actual sync mechanics to runSyncForConnection in
 * src/lib/quickbooksSync.ts - moved there so the weekly-email cron job can
 * call the exact same sync logic in-process without a user session (see
 * api/cron/weekly-email/route.ts). Nothing about the sync algorithm itself
 * changed as part of that move.
 */
export async function POST(req: NextRequest) {
  try {
    return await runSync(req);
  } catch (err) {
    // Always return JSON on failure so the dashboard button shows a real
    // error instead of hanging forever. Log only the error message, never
    // the full error object - Intuit's security review explicitly prohibits
    // logging customer QuickBooks data or credentials, and some SDK error
    // objects embed the request/response body (which could contain either)
    // in fields beyond `.message`.
    console.error("quickbooks/sync failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Sync failed." },
      { status: 500 }
    );
  }
}

async function runSync(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { connectionId } = await req.json();
  const connection = await prisma.quickBooksConnection.findUnique({
    where: { id: connectionId },
  });

  if (!connection || connection.userId !== session.userId) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  const result = await runSyncForConnection(connectionId);
  return NextResponse.json(result);
}
