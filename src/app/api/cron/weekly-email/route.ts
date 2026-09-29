import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateWeeklyDigestForConnection, SummaryOutOfTimeError, summaryToReuse, withSummaryForRetry } from "@/lib/digest";
import { runSyncForConnection, SyncAlreadyRunningError, FullSyncNotAllowedError, COST_SYNC_VERSION, SYNC_VERSION } from "@/lib/quickbooksSync";
import { jobSourceQuestionPending } from "@/lib/jobSetup";
import { authorizeCron } from "@/lib/cronAuth";
import { renderBriefEmail } from "@/lib/email/briefEmail";
import { sendBriefOnHold, sendWeeklyBrief } from "@/lib/email/lifecycle";
import { getEntitlements } from "@/lib/entitlements";
import { overLimitConnectionIds } from "@/lib/planLimits";
import { isValidTimeZone, lastScheduledSend, withinCatchUp } from "@/lib/schedule";
import { customerSyncError, syncLooksFailed } from "@/lib/briefSend";

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
 *    a week, so one broken connection cannot use up every run. Only its
 *    own failures count: an AI outage sends the brief without the written
 *    summary, a company started too late in a run to write the summary is
 *    left to the next run, and a send the email provider couldn't take is
 *    retried an hour later, with the same summary, without using an attempt.
 *  - No full sync ever runs here. One can take longer than this whole run,
 *    and when the platform cut it off it took other companies' briefs down
 *    with it, partway through sending. A company that needs one waits for
 *    the nightly sync.
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const CONCURRENCY = 4;
const STOP_STARTING_AFTER_MS = 200_000;
/** The AI write-up must be done by this point in the run, leaving time to send. */
const AI_DEADLINE_MS = 280_000;
const MAX_ATTEMPTS = 5;
/** A sync this recent (the nightly one, say) is fresh enough for the brief. */
const FRESH_SYNC_MS = 6 * 3_600_000;
/** A claim older than this belongs to a run that died. */
const CLAIM_TTL_MS = 10 * 60_000;
/** Past this point in a run, don't start a sync before a brief: build it from what's synced. */
const SKIP_SYNC_AFTER_MS = 150_000;
/** Kept a day under the sync's own 30-day full-sync interval, so a sync started here is never a full one. */
const FULL_SYNC_DUE_MS = 29 * 86_400_000;
/** How long a brief held back by a failing upgrade sync waits before the owner is told. */
const HOLD_NOTICE_AFTER_MS = 24 * 3_600_000;
/** After a send the email provider couldn't take, try again this much later. */
const RETRY_SEND_AFTER_MS = 60 * 60_000;
/**
 * A company deferred for lack of time is only deferred while a run this much
 * later is still inside the catch-up window (runs are 15 minutes apart).
 * Past that, the brief goes without the summary rather than not at all.
 */
const DEFER_MARGIN_MS = 30 * 60_000;

type Result = { connectionId: string; status: string; detail?: string };
type Connection = Awaited<ReturnType<typeof prisma.quickBooksConnection.findMany>>[number];

/** Per-account facts looked up once per run, not once per company: a firm can have dozens. */
function accountFacts() {
  const paused = new Map<string, Promise<Set<string>>>();
  const companies = new Map<string, Promise<number>>();
  return {
    isPaused: async (c: Connection) => {
      if (!paused.has(c.userId)) paused.set(c.userId, overLimitConnectionIds(c.userId));
      return (await paused.get(c.userId)!).has(c.id);
    },
    companyCount: (ownerId: string) => {
      if (!companies.has(ownerId)) {
        companies.set(ownerId, prisma.quickBooksConnection.count({ where: { userId: ownerId, disconnectedAt: null } }));
      }
      return companies.get(ownerId)!;
    },
  };
}

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
  const due: { connection: Connection; scheduledAt: Date; weekStarting: Date }[] = [];

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

  const facts = accountFacts();
  let next = 0;
  const worker = async () => {
    while (next < due.length) {
      if (Date.now() - startedAt > STOP_STARTING_AFTER_MS) return;
      const item = due[next++];
      results.push(await sendOne(item.connection, item.weekStarting, item.scheduledAt, startedAt, facts));
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
  connection: Connection,
  weekStarting: Date,
  scheduledAt: Date,
  runStartedAt: number,
  facts: ReturnType<typeof accountFacts>
): Promise<Result> {
  let claimed = false;
  const release = (data: Record<string, unknown> = {}) =>
    prisma.quickBooksConnection.update({ where: { id: connection.id }, data: { briefClaimedAt: null, ...data } });
  try {
    // Already sent this week? (A retry, or a second run in the window.)
    const existing = await prisma.weeklyDigest.findUnique({
      where: { connectionId_weekStarting: { connectionId: connection.id, weekStarting } },
      select: { emailedAt: true, metrics: true },
    });
    if (existing?.emailedAt) return { connectionId: connection.id, status: "skipped", detail: "already emailed this week" };
    // An earlier try at this week's send already wrote the summary (the email
    // provider couldn't take it, or the run died partway): the retry sends
    // the same words instead of writing new ones.
    const storedSummary = summaryToReuse(existing?.metrics);

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
    // A company past what the plan covers is paused (see planLimits.ts):
    // no sync, no brief, until the owner disconnects some or upgrades.
    if (await facts.isPaused(connection)) {
      return { connectionId: connection.id, status: "skipped", detail: "paused: the plan covers fewer companies than are connected" };
    }

    // A company still on an older way of storing costs waits for the
    // nightly sync to finish its upgrade: mid-upgrade its costs can read
    // double. That's a full sync, which never runs here, and waiting isn't
    // this brief's fault, so no attempt is used.
    if (connection.syncVersion < COST_SYNC_VERSION) {
      // An upgrade sync that keeps failing (a class-mode company whose
      // QuickBooks has no classes, say) would hold the brief back every
      // week with nobody told. After a day, the owner is told once.
      if (syncLooksFailed(connection, Date.now()) && Date.now() - scheduledAt.getTime() >= HOLD_NOTICE_AFTER_MS) {
        const notice = await sendBriefOnHold({
          ownerId: connection.userId,
          connectionId: connection.id,
          companyName: connection.companyName ?? "Your company",
          lastSyncedAt: connection.lastSyncedAt,
          reason: connection.lastSyncStatus === "error" ? customerSyncError(connection.lastSyncError) : null,
        });
        return {
          connectionId: connection.id,
          status: "deferred",
          detail: `waiting for the upgrade sync, which is failing; owner ${notice.ok ? (notice.skipped ? "already told" : "told") : `not told (${notice.error ?? "send failed"})`}`,
        };
      }
      return { connectionId: connection.id, status: "deferred", detail: "waiting for the upgrade sync to finish" };
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

    // A quick catch-up sync first so the brief reflects the freshest
    // numbers, unless the nightly sync already did, or this run is short on
    // time. Only when it will be incremental: a sync that would be a full
    // one (a new sync version, a rebuild Settings asked for, or the monthly
    // full read) is left to the nightly job, and the brief is built from
    // what's already synced. Nor right after a failed sync: the nightly job
    // retries those, and retrying here every 15 minutes would only repeat
    // the failure.
    const nowMs = Date.now();
    const fresh = connection.lastSyncedAt && nowMs - connection.lastSyncedAt.getTime() < FRESH_SYNC_MS;
    const wouldBeFull =
      connection.syncVersion < SYNC_VERSION ||
      !connection.lastFullSyncAt ||
      nowMs - connection.lastFullSyncAt.getTime() > FULL_SYNC_DUE_MS;
    const failedRecently =
      syncLooksFailed(connection, nowMs) &&
      connection.lastSyncAttemptAt != null &&
      nowMs - connection.lastSyncAttemptAt.getTime() < 3_600_000;
    // Nor when resending a summary already written: it describes the
    // figures as they were synced then.
    if (!storedSummary && !fresh && !wouldBeFull && !failedRecently && nowMs - runStartedAt < SKIP_SYNC_AFTER_MS) {
      try {
        // incrementalOnly: if a full sync turns out to be needed after all
        // (Settings asked for a rebuild a moment ago, or QuickBooks' change
        // feed fails), the sync throws instead of reading everything here.
        await runSyncForConnection(connection.id, { incrementalOnly: true });
      } catch (syncErr) {
        if (syncErr instanceof SyncAlreadyRunningError) {
          // Try again in 15 minutes, without using up an attempt.
          await release(refund);
          claimed = false;
          return { connectionId: connection.id, status: "deferred", detail: "a sync is running" };
        }
        // Otherwise carry on with what is already synced; the brief still goes.
        // A full sync that was needed is left to the nightly job.
        console.error(
          syncErr instanceof FullSyncNotAllowedError
            ? `weekly-email: full sync left to the nightly job for connection ${connection.id}:`
            : `weekly-email: sync failed for connection ${connection.id}:`,
          syncErr instanceof Error ? syncErr.message : "Unknown error"
        );
      }
    }

    const companyName = connection.companyName ?? "Your company";
    let built: Awaited<ReturnType<typeof generateWeeklyDigestForConnection>>;
    try {
      built = await generateWeeklyDigestForConnection(connection.id, weekStarting, companyName, {
        allowMissingSummary: true,
        deadline: runStartedAt + AI_DEADLINE_MS,
        storedSummary,
        deferWhenOutOfTime: withinCatchUp(new Date(Date.now() + DEFER_MARGIN_MS), scheduledAt),
      });
    } catch (err) {
      if (!(err instanceof SummaryOutOfTimeError)) throw err;
      // Started too late in this run to write the summary properly. That's
      // the run's timing, not this company's fault: the attempt is given back
      // and the next run, where it is near the front of the queue, sends the
      // brief with its summary.
      await release(refund);
      claimed = false;
      return { connectionId: connection.id, status: "deferred", detail: `no time left for the summary in this run (${err.message})` };
    }
    const { narrative, kind, metrics, body, weekOverWeek, headline, tiles, summaryMissing } = built;
    const toStore = withSummaryForRetry(metrics, { kind, body, summaryMissing });

    const digest = await prisma.weeklyDigest.upsert({
      where: { connectionId_weekStarting: { connectionId: connection.id, weekStarting } },
      create: { connectionId: connection.id, weekStarting, metrics: toStore as any, narrative, kind },
      update: { metrics: toStore as any, narrative, kind },
    });

    // One message per recipient, so each gets their own unsubscribe link,
    // and each recorded on its own: a recipient who already has this week's
    // brief (from a run that died partway) isn't sent it again.
    const hasOtherCompanies = (await facts.companyCount(connection.userId)) > 1;
    let sent = 0;
    const retryLater: string[] = [];
    const refused: string[] = [];
    for (const recipient of connection.emailRecipients) {
      const email = renderBriefEmail({
        connectionId: connection.id,
        companyName,
        weekStarting,
        kind,
        body,
        weekOverWeek,
        metrics,
        headline,
        tiles,
        summaryMissing,
        recipient,
        ownerEmail: owner.email,
        hasOtherCompanies,
        // Not held back for the "Is each job a Class?" answer: it points to the question.
        jobSourceQuestionPending: jobSourceQuestionPending(connection),
      });
      const result = await sendWeeklyBrief({
        ownerId: connection.userId,
        connectionId: connection.id,
        weekStarting,
        recipient,
        email: { subject: email.subject, html: email.html, text: email.text, headers: email.headers },
      });
      if (result.ok) sent++;
      else if (result.transient) retryLater.push(result.error ?? "unknown error");
      else refused.push(result.error ?? "unknown error");
    }
    const note = `${kind}${summaryMissing ? " without summary" : ""}, ${sent} of ${connection.emailRecipients.length} recipients`;

    if (retryLater.length > 0) {
      // The email provider couldn't take some of them: not this company's
      // fault, so the attempt is given back, and the brief is tried again in
      // an hour for whoever didn't get it. (A claim is honoured for
      // CLAIM_TTL_MS, so setting it this far ahead holds the company until
      // then.)
      await release({ ...refund, briefClaimedAt: new Date(Date.now() + RETRY_SEND_AFTER_MS - CLAIM_TTL_MS) });
      claimed = false;
      return { connectionId: connection.id, status: "retry_later", detail: `${note}; will retry: ${retryLater.join("; ")}` };
    }
    if (sent > 0) {
      await prisma.weeklyDigest.update({ where: { id: digest.id }, data: { emailedAt: new Date() } });
      await release();
      claimed = false;
      return {
        connectionId: connection.id,
        status: "sent",
        detail: `${note}${refused.length ? `; failed: ${refused.join("; ")}` : ""}`,
      };
    }
    await release();
    claimed = false;
    return { connectionId: connection.id, status: "generated_not_sent", detail: refused.join("; ") };
  } catch (err) {
    // One company's failure must never take down the rest of the run.
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`weekly-email: failed for connection ${connection.id}: ${message}`);
    if (claimed) await release().catch(() => {});
    return { connectionId: connection.id, status: "error", detail: message };
  }
}
