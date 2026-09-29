import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { connectionForAccount, getAccount, refuseClient } from "@/lib/account";
import { runSyncForConnection, SyncAlreadyRunningError } from "@/lib/quickbooksSync";
import { getEntitlements, inactiveMessage } from "@/lib/entitlements";
import { overLimitConnectionIds, pausedCompaniesMessage } from "@/lib/planLimits";
import { syncCooldownMessage, syncCooldownSecondsLeft } from "@/lib/syncCooldown";

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
// A first sync of a company with years of history reads every transaction.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    return await runSync(req);
  } catch (err) {
    if (err instanceof SyncAlreadyRunningError) {
      return NextResponse.json({ error: err.message, code: "sync_in_progress" }, { status: 409 });
    }
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
  const account = await getAccount();
  if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const refused = refuseClient(account);
  if (refused) return refused;

  // Server-side entitlement check - a lapsed account must not be able to
  // keep pulling fresh QuickBooks data by calling the API directly.
  const entitlements = await getEntitlements(account.ownerId);
  if (!entitlements.active) {
    return NextResponse.json({ error: inactiveMessage(entitlements), code: "entitlement_required" }, { status: 402 });
  }

  const body = await req.json().catch(() => ({}));
  // Scoped to this login's account, and a disconnected company isn't synced.
  const connection = await connectionForAccount(account, body?.connectionId);
  if (!connection) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  // A company past the plan's company limit keeps the figures it has but
  // isn't synced (src/lib/planLimits.ts). The nightly job skips it too.
  const paused = await overLimitConnectionIds(account.ownerId);
  if (paused.has(connection.id)) {
    const name = connection.companyName?.trim() || "This company";
    return NextResponse.json(
      {
        error: `${pausedCompaniesMessage([name], entitlements.limits.maxConnections)} A paused company keeps its figures but doesn't sync. Billing shows what to do.`,
        code: "company_paused",
      },
      { status: 403 }
    );
  }

  // When the last sync started, so a rebuild asked for since (a change of
  // job setup) isn't held back by the pause (see syncCooldown.ts).
  const lastRun = await prisma.syncRun.findFirst({
    where: { connectionId: connection.id },
    orderBy: { startedAt: "desc" },
    select: { startedAt: true },
  });
  const wait = syncCooldownSecondsLeft({ ...connection, lastSyncStartedAt: lastRun?.startedAt ?? null });
  if (wait > 0) {
    return NextResponse.json(
      { error: syncCooldownMessage(wait), code: "sync_cooldown", retryAfterSeconds: wait },
      { status: 429, headers: { "Retry-After": String(wait) } }
    );
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
  // The cost of always going full is bounded - one paged read per entity,
  // and only changed rows are written - and this is a button a person
  // presses occasionally, not the scheduled syncs, which use the
  // incremental path (they call runSyncForConnection without this flag).
  //
  // A deadline keeps a large company's read inside this route's 300-second
  // limit: the sync stops between steps, says so, and the next press (within
  // the hour) or the nightly sync carries on from where it stopped.
  const result = await runSyncForConnection(connection.id, {
    forceFull: true,
    deadline: Date.now() + 240_000,
    resumeWithinMs: 60 * 60_000,
  });
  return NextResponse.json(result);
}
