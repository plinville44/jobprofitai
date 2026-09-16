import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { runSyncForConnection } from "@/lib/quickbooksSync";
import { getEntitlements } from "@/lib/entitlements";

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

  // Server-side entitlement check - a lapsed account must not be able to
  // keep pulling fresh QuickBooks data by calling the API directly.
  const entitlements = await getEntitlements(session.userId);
  if (!entitlements.active) {
    return NextResponse.json(
      { error: "Your JobProfitAI trial has ended. Choose a plan to continue.", code: "entitlement_required" },
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

  // A person clicking Sync now always gets a full read, never the lighter
  // incremental path.
  //
  // Incremental sync asks QuickBooks only what changed, which means it can
  // never repair anything: a record QuickBooks considers unchanged is never
  // revisited, even when we have started storing a field we did not store
  // before, or fixed how we read one. That produced two separate "why isn't
  // my data updating" episodes during testing, and a contractor has no way
  // to reason about it.
  //
  // The cost of always going full is small and bounded - six queries capped
  // at 1000 rows each - and this is a button a person presses occasionally,
  // not the hourly cron, which still uses the incremental path (it calls
  // runSyncForConnection without this flag).
  const result = await runSyncForConnection(connectionId, { forceFull: true });
  return NextResponse.json(result);
}
