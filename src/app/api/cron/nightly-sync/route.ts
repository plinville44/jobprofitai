import { NextRequest, NextResponse } from "next/server";
import type { QuickBooksConnection } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authorizeCron } from "@/lib/cronAuth";
import { FULL_SYNC_TOO_LONG_MESSAGE, FullSyncNotAllowedError, fullSyncDue, runSyncForConnection } from "@/lib/quickbooksSync";
import { getEntitlements } from "@/lib/entitlements";
import { overLimitConnectionIds } from "@/lib/planLimits";
import { evaluateAlerts, markAlertsSent } from "@/lib/alerts";
import { renderAlertEmail } from "@/lib/email/briefEmail";
import { sendProfitAlerts } from "@/lib/email/lifecycle";
import { alertsDelivered, alertSendFailure } from "@/lib/briefSend";
import { freezeClosedSnapshots, takeWipSnapshot } from "@/lib/wipSnapshots";

/**
 * GET /api/cron/nightly-sync  (Vercel Cron, hourly; see vercel.json)
 *
 * Keeps every paying or trialing company synced at least once a day, and
 * sends profit alerts from what each sync finds.
 *
 * Before this, data only refreshed right before the Monday brief or when
 * someone clicked Sync now, so the dashboard could be a week old and
 * nothing could warn anyone mid-week. Each hourly run syncs the companies
 * that have gone longest without a sync (over 20 hours), a few at a time,
 * within a time budget; the rest wait for the next hour.
 *
 * Full syncs (a company's first, the monthly one, one under new sync rules)
 * read a company's whole history, which for a big company can take longer
 * than a whole run. They get a slot of their own: one at a time, alongside
 * the incremental syncs, each with a deadline. A full sync stops between two
 * of its steps when its time is nearly up and the next run carries on with
 * the rest (see FULL_SYNC_STEPS in src/lib/quickbooksSync.ts). Before, one
 * that outlasted the time limit was cut off, retried every hour, and took
 * every other sync and alert email in that run down with it.
 *
 * Month-end WIP snapshots (src/lib/wipSnapshots.ts) come last, for the
 * companies this run synced cleanly, once every sync and alert email in the
 * run is done, so they can never hold one up. They start only while there's
 * time left (SNAPSHOTS_STOP_STARTING_AFTER_MS); any not reached wait for the
 * company's next sync, which is fine, as a month's snapshot is taken again
 * daily for weeks.
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const STALE_AFTER_MS = 20 * 3_600_000;
const RETRY_FAILED_AFTER_MS = 2 * 3_600_000;
/** Start of every "you need to reconnect" error the sync stores (see needsReconnect). */
const RECONNECT_PREFIX = "Your QuickBooks connection has expired or was disconnected";
/** Incremental syncs running at once, besides the one full-sync slot. */
const CONCURRENCY = 3;
/**
 * No new incremental sync starts after this, leaving about three minutes
 * before the 300 s limit for the ones already running. A sync started later
 * could be cut off at the limit, which ends it without a trace: it stays "in
 * progress" and, before the rule below, wasn't tried again for a day.
 */
const STOP_STARTING_AFTER_MS = 110_000;
/**
 * When, into the run, a full sync should be done by. It starts no step that
 * isn't expected to finish by then, which leaves the last stretch before the
 * 300 s limit for a step that runs long, its alert emails and the response.
 */
const FULL_SYNC_DONE_BY_MS = 220_000;
/** A full sync starts only with at least this long before its deadline: less gets little done. */
const FULL_SYNC_MIN_TIME_MS = 60_000;
/** A sync still "in progress" after this long was cut off; it's retried like a failed one. */
const INTERRUPTED_AFTER_MS = 15 * 60_000;
/**
 * No WIP snapshot starts after this, leaving a minute before the 300 s limit
 * for the one being worked out (one company's figures, the same work as a
 * view of its WIP page) and the response. Later than the full sync's
 * deadline, and only reached once every sync is done.
 */
const SNAPSHOTS_STOP_STARTING_AFTER_MS = 240_000;

type SyncOptions = { deadline?: number; deferFullSync?: boolean; windowStart?: number };

export async function GET(req: NextRequest) {
  const auth = authorizeCron(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const startedAt = Date.now();
  const now = new Date(startedAt);
  const staleBefore = new Date(startedAt - STALE_AFTER_MS);
  const interruptedBefore = new Date(startedAt - INTERRUPTED_AFTER_MS);
  const notWaitingForReconnect = { OR: [{ lastSyncError: null }, { NOT: { lastSyncError: { startsWith: RECONNECT_PREFIX } } }] };

  // A full sync already down to one try a day that was then cut off at the
  // time limit can't record that itself. Marked failed here, so the
  // dashboard says so instead of "in progress".
  await prisma.quickBooksConnection.updateMany({
    where: { lastSyncStatus: "in_progress", lastSyncAttemptAt: { lt: interruptedBefore }, lastSyncError: FULL_SYNC_TOO_LONG_MESSAGE },
    data: { lastSyncStatus: "error" },
  });

  // Full syncs owed, or stopped partway, whose time has come (see
  // fullSyncContinueAt), oldest first. Asked for on their own, so a long
  // queue of companies due their daily sync can't push them out of the 200.
  const continuing = await prisma.quickBooksConnection.findMany({
    where: {
      disconnectedAt: null,
      fullSyncContinueAt: { lte: now },
      AND: [
        notWaitingForReconnect,
        // Not one running right now (a person's Sync now, say).
        { OR: [{ lastSyncStatus: null }, { lastSyncStatus: { not: "in_progress" } }, { lastSyncAttemptAt: { lt: interruptedBefore } }] },
      ],
    },
    // One whose first step didn't fit late in the last run is set to the
    // epoch, so it's first and starts at the beginning of this run's window.
    orderBy: [{ fullSyncContinueAt: "asc" }, { lastSyncAttemptAt: { sort: "asc", nulls: "first" } }],
    take: 50,
  });

  // Chosen by when a sync was last ATTEMPTED, not when one last succeeded,
  // and a skipped company has its attempt time bumped (see syncAndAlert).
  // Otherwise lapsed trials and companies that failed would sit at the
  // front of the queue forever and, past 200 of them, crowd out every
  // paying customer. Connections waiting for the customer to reconnect
  // aren't tried at all: nothing works until they do. Nor are those whose
  // full sync waits for a later time (one that keeps running out of time is
  // tried once a day).
  const due = await prisma.quickBooksConnection.findMany({
    where: {
      disconnectedAt: null,
      fullSyncContinueAt: null,
      AND: [
        { OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: staleBefore } }] },
        {
          OR: [
            { lastSyncAttemptAt: null },
            { lastSyncAttemptAt: { lt: staleBefore } },
            // A sync that failed (and not for want of a reconnect) is
            // retried after a couple of hours rather than a day, behind
            // everything that has waited longer.
            { lastSyncStatus: "error", lastSyncAttemptAt: { lt: new Date(startedAt - RETRY_FAILED_AFTER_MS) } },
            // One that was cut off mid-sync (the function hit its time
            // limit) is retried on the next run, not tomorrow.
            { lastSyncStatus: "in_progress", lastSyncAttemptAt: { lt: interruptedBefore } },
          ],
        },
        notWaitingForReconnect,
      ],
    },
    orderBy: { lastSyncAttemptAt: { sort: "asc", nulls: "first" } },
    take: 200,
  });

  // Which sync each company gets, decided the way the sync itself decides.
  // A full sync that turns out to be needed after all (Settings asked for a
  // rebuild a moment ago, or QuickBooks' change feed fails) isn't run by an
  // incremental worker: it's left for the full-sync slot (deferFullSync).
  const fullQueue = [...continuing, ...due.filter((c) => fullSyncDue(c, startedAt))];
  const incrementalQueue = due.filter((c) => !fullSyncDue(c, startedAt));

  // Companies past their plan's company limit, worked out once per account
  // per run (src/lib/planLimits.ts). Kept as promises so workers asking about
  // the same account at once share one lookup.
  const pausedByOwner = new Map<string, Promise<Set<string>>>();
  const pausedFor = (ownerId: string) => {
    let paused = pausedByOwner.get(ownerId);
    if (!paused) {
      paused = overLimitConnectionIds(ownerId);
      pausedByOwner.set(ownerId, paused);
    }
    return paused;
  };

  const results: { connectionId: string; status: string; detail?: string }[] = [];
  /** Companies whose sync in this run finished cleanly, for the WIP snapshots. */
  const synced: QuickBooksConnection[] = [];
  const onSynced = (connection: QuickBooksConnection) => synced.push(connection);
  /** A worker over one queue; workers made from the same call share it. */
  const drain = (queue: QuickBooksConnection[], options: SyncOptions, mayStart: () => boolean) => {
    let next = 0;
    return async () => {
      while (next < queue.length) {
        if (!mayStart()) return;
        const connection = queue[next++];
        results.push(await syncAndAlert(connection, pausedFor, options, onSynced));
      }
    };
  };
  const incrementalWorker = drain(incrementalQueue, { deferFullSync: true }, () => Date.now() - startedAt <= STOP_STARTING_AFTER_MS);
  const fullDeadline = startedAt + FULL_SYNC_DONE_BY_MS;
  const fullWorker = drain(fullQueue, { deadline: fullDeadline, windowStart: startedAt }, () => Date.now() + FULL_SYNC_MIN_TIME_MS <= fullDeadline);
  await Promise.all([...Array.from({ length: CONCURRENCY }, () => incrementalWorker()), fullWorker()]);

  // Only now, with every sync and alert email done: one at a time, while
  // there's time. Freezing first, so a snapshot whose window has closed is
  // frozen even for a company that wasn't synced (paused, disconnected).
  const snapshots: { connectionId: string; status: string; detail?: string }[] = [];
  const snapshotTime = () => Date.now() - startedAt <= SNAPSHOTS_STOP_STARTING_AFTER_MS;
  let snapshotsFrozen = 0;
  if (snapshotTime()) {
    try {
      snapshotsFrozen = await freezeClosedSnapshots(new Date());
    } catch (err) {
      console.error(`nightly-sync: freezing WIP snapshots failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  }
  for (const connection of synced) {
    if (!snapshotTime()) break;
    let paused: boolean;
    try {
      paused = (await pausedFor(connection.userId)).has(connection.id);
    } catch {
      continue;
    }
    snapshots.push(await takeWipSnapshot(connection.id, { paused }));
  }

  return NextResponse.json({
    ok: true,
    candidates: fullQueue.length + incrementalQueue.length,
    fullSyncs: fullQueue.length,
    processed: results.length,
    results,
    snapshotsFrozen,
    snapshots,
  });
}

async function syncAndAlert(
  connection: QuickBooksConnection,
  pausedFor: (ownerId: string) => Promise<Set<string>>,
  options: SyncOptions,
  /** Called once the company's sync has finished cleanly (not partway, not deferred). */
  onSynced: (connection: QuickBooksConnection) => void
) {
  // To the back of the queue until tomorrow, and a full sync that's owed
  // waits as long.
  const skip = async (detail: string) => {
    await prisma.quickBooksConnection.update({
      where: { id: connection.id },
      data: {
        lastSyncAttemptAt: new Date(),
        ...(connection.fullSyncContinueAt ? { fullSyncContinueAt: new Date(Date.now() + STALE_AFTER_MS) } : {}),
      },
    });
    return { connectionId: connection.id, status: "skipped", detail };
  };
  try {
    // Lapsed accounts are not synced: that is paid work, and their tokens
    // are left alone until they come back.
    const entitlements = await getEntitlements(connection.userId);
    if (!entitlements.active) return await skip(`no active entitlement (${entitlements.access})`);
    // Nor are companies past the plan's company limit: they keep the figures
    // they have until the owner disconnects some or changes plan. No sync
    // means no alerts either.
    if ((await pausedFor(connection.userId)).has(connection.id)) return await skip("paused: past the plan's company limit");

    let sync: Record<string, any>;
    try {
      sync = await runSyncForConnection(connection.id, options);
    } catch (err) {
      if (err instanceof FullSyncNotAllowedError) {
        return { connectionId: connection.id, status: "deferred", detail: "full sync left for the full-sync slot" };
      }
      throw err;
    }
    // Its first step wouldn't have finished in the time left: nothing was
    // started, and it's first in line next run.
    if (sync.deferred) {
      return { connectionId: connection.id, status: "deferred", detail: "full sync waits for the start of the next run" };
    }
    // Stopped partway through a full sync: its figures are part rewritten,
    // so alerts wait for the run that finishes it.
    if (sync.unfinished) {
      const left = Array.isArray(sync.remaining) ? sync.remaining.length : 0;
      return { connectionId: connection.id, status: "synced", detail: `full sync partway, ${left} step(s) left for the next run` };
    }
    // Before the alerts, so a failed alert email doesn't cost the company
    // its WIP snapshot.
    onSynced(connection);

    if (!connection.alertsEnabled || !connection.emailEnabled || connection.emailRecipients.length === 0) {
      return { connectionId: connection.id, status: "synced" };
    }
    const owner = await prisma.user.findUnique({ where: { id: connection.userId }, select: { email: true, emailVerifiedAt: true } });
    const { pending: newAlerts, baseline } = await evaluateAlerts(connection.id);
    if (baseline) return { connectionId: connection.id, status: "synced", detail: "alerts baselined" };
    // Unsent alerts stay pending and go out once the owner has verified.
    if (newAlerts.length === 0 || !owner?.emailVerifiedAt) return { connectionId: connection.id, status: "synced" };
    return { connectionId: connection.id, status: "synced", detail: await emailAlerts(connection, owner.email, newAlerts) };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`nightly-sync: failed for connection ${connection.id}: ${message}`);
    return { connectionId: connection.id, status: "error", detail: message };
  }
}

/**
 * One email per recipient, each with its own unsubscribe link, listing the
 * alerts that recipient hasn't had (each alert goes to each address once;
 * see sendProfitAlerts). An alert is marked sent only once every recipient
 * who can get it has it: one whose send may work next time gets it at the
 * next run, and a run cut off partway through the list doesn't send it
 * again to those who already have it.
 */
async function emailAlerts(
  connection: QuickBooksConnection,
  ownerEmail: string,
  newAlerts: Awaited<ReturnType<typeof evaluateAlerts>>["pending"]
): Promise<string> {
  // Each alert's own row: one that clears and fires again later is a new
  // row, so it's a new alert to everyone.
  const rows = await prisma.jobAlert.findMany({
    where: { job: { connectionId: connection.id }, emailed: false },
    select: { id: true, jobId: true, kind: true },
  });
  const idOf = new Map(rows.map((r) => [`${r.jobId}:${r.kind}`, r.id]));
  const alerts = newAlerts.flatMap((a) => {
    const alertId = idOf.get(`${a.jobId}:${a.kind}`);
    return alertId ? [{ ...a, alertId }] : [];
  });
  if (alerts.length === 0) return "no alerts to send";

  // With other companies on the account, the footer also offers stopping
  // the emails for all of them, as the weekly brief's does.
  const hasOtherCompanies = (await prisma.quickBooksConnection.count({ where: { userId: connection.userId, disconnectedAt: null } })) > 1;
  const outcomes: { has: string[]; failed: "retry" | "refused" | null }[] = [];
  let sent = 0;
  for (const recipient of connection.emailRecipients) {
    const { result, has } = await sendProfitAlerts({
      ownerId: connection.userId,
      recipient,
      alerts,
      render: (these) =>
        renderAlertEmail({
          connectionId: connection.id,
          companyName: connection.companyName ?? "Your company",
          alerts: these,
          recipient,
          ownerEmail,
          hasOtherCompanies,
        }),
    });
    if (result.ok && !result.skipped) sent++;
    outcomes.push({ has, failed: alertSendFailure(result) });
  }
  const done = new Set(alertsDelivered(alerts.map((a) => a.alertId), outcomes));
  const delivered = alerts.filter((a) => done.has(a.alertId));
  if (delivered.length > 0) await markAlertsSent(delivered);
  const waiting = alerts.length - delivered.length;
  return `${alerts.length} alert(s), ${sent} email(s)${waiting > 0 ? `, ${waiting} still to send` : ""}`;
}
