import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateWeeklyDigestForConnection } from "@/lib/digest";
import { runSyncForConnection, SyncAlreadyRunningError, SYNC_VERSION } from "@/lib/quickbooksSync";
import { authorizeCron } from "@/lib/cronAuth";
import { sendEmail } from "@/lib/email/client";
import { renderBriefEmail } from "@/lib/email/briefEmail";
import { getEntitlements } from "@/lib/entitlements";
import { isValidTimeZone, lastScheduledSend, withinCatchUp } from "@/lib/schedule";

/**
 * GET /api/cron/weekly-email  (Vercel Cron, every 15 minutes; see vercel.json)
 *
 * Sends each company's Weekly Profit Brief on the day and hour set in
 * Settings, in that company's time zone.
 *
 * Built to keep working as the customer count grows:
 *
 *  - A brief is due from its scheduled time until it has been sent (for up
 *    to 48 hours), not only during the one matching hour. A run that timed
 *    out, an AI outage or a failed sync used to cost that customer the
 *    whole week; now the next run picks it up.
 *  - Due companies are worked through several at a time, oldest-due first,
 *    and the run stops starting new ones with time to spare, leaving the
 *    rest to the next run 15 minutes later.
 *  - A company that keeps failing is retried at most MAX_ATTEMPTS times in
 *    a week, so one broken connection cannot use up every run.
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const CONCURRENCY = 4;
const STOP_STARTING_AFTER_MS = 200_000;
const MAX_ATTEMPTS = 5;
/** A sync this recent (the nightly one, say) is fresh enough for the brief. */
const FRESH_SYNC_MS = 6 * 3_600_000;
/** A claim older than this belongs to a run that died. */
const CLAIM_TTL_MS = 10 * 60_000;
/** Past this point in a run, don't start a sync before a brief: build it from what's synced. */
const SKIP_SYNC_AFTER_MS = 150_000;

type Result = { connectionId: string; status: string; detail?: string };

export async function GET(req: NextRequest) {
  // Fails closed in production when CRON_SECRET is missing (see cronAuth.ts).
  const auth = authorizeCron(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const startedAt = Date.now();
  const now = new Date();
  const connections = await prisma.quickBooksConnection.findMany({
    where: { disconnectedAt: null, emailEnabled: true },
  });

  const results: Result[] = [];
  const due: { connection: (typeof connections)[number]; scheduledAt: Date; weekStarting: Date }[] = [];

  for (const connection of connections) {
    const timeZone = isValidTimeZone(connection.emailTimezone) ? connection.emailTimezone : "America/New_York";
    const { scheduledAt, weekStarting } = lastScheduledSend(now, {
      day: connection.emailDay,
      hour: connection.emailHour,
      timeZone,
    });
    if (!withinCatchUp(now, scheduledAt)) {
      results.push({ connectionId: connection.id, status: "not_due" });
      continue;
    }
    if (
      connection.briefAttemptWeek?.getTime() === weekStarting.getTime() &&
      connection.briefAttempts >= MAX_ATTEMPTS
    ) {
      results.push({ connectionId: connection.id, status: "gave_up", detail: `${MAX_ATTEMPTS} failed attempts this week` });
      continue;
    }
    due.push({ connection, scheduledAt, weekStarting });
  }

  // Oldest-due first, so a backlog drains in order.
  due.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());

  let next = 0;
  const worker = async () => {
    while (next < due.length) {
      if (Date.now() - startedAt > STOP_STARTING_AFTER_MS) return;
      const item = due[next++];
      results.push(await sendOne(item.connection, item.weekStarting, startedAt));
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  for (let i = next; i < due.length; i++) {
    results.push({ connectionId: due[i].connection.id, status: "deferred", detail: "left for the next run" });
  }

  return NextResponse.json({
    ok: true,
    checkedAt: now.toISOString(),
    connectionsConsidered: connections.length,
    due: due.length,
    results: results.filter((r) => r.status !== "not_due"),
    notDue: results.filter((r) => r.status === "not_due").length,
  });
}

async function sendOne(
  connection: Awaited<ReturnType<typeof prisma.quickBooksConnection.findMany>>[number],
  weekStarting: Date,
  runStartedAt: number
): Promise<Result> {
  let claimed = false;
  const release = (data: Record<string, unknown> = {}) =>
    prisma.quickBooksConnection.update({ where: { id: connection.id }, data: { briefClaimedAt: null, ...data } });
  try {
    // Already sent this week? (A retry, or a second run in the window.)
    const existing = await prisma.weeklyDigest.findUnique({
      where: { connectionId_weekStarting: { connectionId: connection.id, weekStarting } },
      select: { emailedAt: true },
    });
    if (existing?.emailedAt) return { connectionId: connection.id, status: "skipped", detail: "already emailed this week" };

    if (connection.emailRecipients.length === 0) {
      return { connectionId: connection.id, status: "skipped", detail: "no recipients configured" };
    }

    // Nothing is sent until the account owner has verified their address:
    // an unverified signup typo would otherwise send one company's job
    // figures to a stranger every week.
    const owner = await prisma.user.findUnique({
      where: { id: connection.userId },
      select: { emailVerifiedAt: true, email: true },
    });
    if (!owner?.emailVerifiedAt) {
      return { connectionId: connection.id, status: "skipped", detail: "account owner has not verified their email address" };
    }

    // Entitlement, enforced here like every other paid path.
    const entitlements = await getEntitlements(connection.userId);
    if (!entitlements.active) {
      return { connectionId: connection.id, status: "skipped", detail: `no active entitlement (${entitlements.access})` };
    }

    // Claim it: one run at a time per company. The attempt counts now, so
    // a run that times out still uses one of the week's attempts instead of
    // regenerating (and paying for) the brief every 15 minutes for two days.
    const sameWeek = connection.briefAttemptWeek?.getTime() === weekStarting.getTime();
    const claim = await prisma.quickBooksConnection.updateMany({
      where: {
        id: connection.id,
        OR: [{ briefClaimedAt: null }, { briefClaimedAt: { lt: new Date(Date.now() - CLAIM_TTL_MS) } }],
      },
      data: {
        briefClaimedAt: new Date(),
        briefAttemptWeek: weekStarting,
        briefAttempts: sameWeek ? { increment: 1 } : 1,
      },
    });
    if (claim.count === 0) return { connectionId: connection.id, status: "skipped", detail: "another run is sending it" };
    claimed = true;
    const refund = sameWeek ? { briefAttempts: connection.briefAttempts } : { briefAttempts: 0 };

    // Another run may have finished it between the check above and the claim.
    const sentMeanwhile = await prisma.weeklyDigest.findUnique({
      where: { connectionId_weekStarting: { connectionId: connection.id, weekStarting } },
      select: { emailedAt: true },
    });
    if (sentMeanwhile?.emailedAt) {
      await release(refund);
      claimed = false;
      return { connectionId: connection.id, status: "skipped", detail: "already emailed this week" };
    }

    // Sync first so the brief reflects the freshest numbers, unless the
    // nightly sync already did, or this run is short on time. A company
    // still on an older sync version must finish its upgrade sync first:
    // mid-upgrade its costs can read double.
    const fresh = connection.lastSyncedAt && Date.now() - connection.lastSyncedAt.getTime() < FRESH_SYNC_MS;
    const needsUpgrade = connection.syncVersion < SYNC_VERSION;
    // Nor right after a failed sync: the nightly job retries those, and
    // retrying here every 15 minutes would only repeat the failure.
    const failedRecently =
      connection.lastSyncStatus === "error" &&
      connection.lastSyncAttemptAt != null &&
      Date.now() - connection.lastSyncAttemptAt.getTime() < 3_600_000;
    if ((!fresh || needsUpgrade) && !failedRecently && Date.now() - runStartedAt < SKIP_SYNC_AFTER_MS) {
      try {
        await runSyncForConnection(connection.id);
      } catch (syncErr) {
        if (syncErr instanceof SyncAlreadyRunningError) {
          // Try again in 15 minutes, without using up an attempt.
          await release(refund);
          claimed = false;
          return { connectionId: connection.id, status: "deferred", detail: "a sync is running" };
        }
        // Otherwise carry on with what is already synced; the brief still goes.
        console.error(
          `weekly-email: sync failed for connection ${connection.id}:`,
          syncErr instanceof Error ? syncErr.message : "Unknown error"
        );
      }
    }
    if (needsUpgrade) {
      const now = await prisma.quickBooksConnection.findUnique({ where: { id: connection.id }, select: { syncVersion: true } });
      if ((now?.syncVersion ?? 0) < SYNC_VERSION) {
        // Not this brief's fault: the attempt is given back, and the
        // nightly sync (or the next run) finishes the upgrade.
        await release(refund);
        claimed = false;
        return { connectionId: connection.id, status: "deferred", detail: "waiting for the upgrade sync to finish" };
      }
    }

    const companyName = connection.companyName ?? "Your company";
    const { narrative, kind, metrics, body, weekOverWeek } = await generateWeeklyDigestForConnection(
      connection.id,
      weekStarting,
      companyName
    );

    const digest = await prisma.weeklyDigest.upsert({
      where: { connectionId_weekStarting: { connectionId: connection.id, weekStarting } },
      create: { connectionId: connection.id, weekStarting, metrics: metrics as any, narrative, kind },
      update: { metrics: metrics as any, narrative, kind },
    });

    // One message per recipient, so each gets their own unsubscribe link.
    let sent = 0;
    const errors: string[] = [];
    for (const recipient of connection.emailRecipients) {
      const email = renderBriefEmail({
        connectionId: connection.id,
        companyName,
        weekStarting,
        kind,
        body,
        weekOverWeek,
        metrics,
        recipient,
        ownerEmail: owner.email,
      });
      const result = await sendEmail({ to: recipient, subject: email.subject, html: email.html, text: email.text, headers: email.headers });
      if (result.ok) sent++;
      else errors.push(result.error ?? "unknown error");
    }

    if (sent > 0) {
      await prisma.weeklyDigest.update({ where: { id: digest.id }, data: { emailedAt: new Date() } });
      await release();
      claimed = false;
      return {
        connectionId: connection.id,
        status: "sent",
        detail: `${kind}, ${sent} of ${connection.emailRecipients.length} recipients${errors.length ? `; failed: ${errors.join("; ")}` : ""}`,
      };
    }
    await release();
    claimed = false;
    return { connectionId: connection.id, status: "generated_not_sent", detail: errors.join("; ") };
  } catch (err) {
    // One company's failure must never take down the rest of the run.
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`weekly-email: failed for connection ${connection.id}: ${message}`);
    if (claimed) await release().catch(() => {});
    return { connectionId: connection.id, status: "error", detail: message };
  }
}
