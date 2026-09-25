import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authorizeCron } from "@/lib/cronAuth";
import { runSyncForConnection } from "@/lib/quickbooksSync";
import { getEntitlements } from "@/lib/entitlements";
import { evaluateAlerts, markAlertsSent } from "@/lib/alerts";
import { renderAlertEmail } from "@/lib/email/briefEmail";
import { sendEmail } from "@/lib/email/client";

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
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const STALE_AFTER_MS = 20 * 3_600_000;
const RETRY_FAILED_AFTER_MS = 2 * 3_600_000;
/** Start of every "you need to reconnect" error the sync stores (see needsReconnect). */
const RECONNECT_PREFIX = "Your QuickBooks connection has expired or was disconnected";
const CONCURRENCY = 3;
const STOP_STARTING_AFTER_MS = 200_000;

export async function GET(req: NextRequest) {
  const auth = authorizeCron(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const startedAt = Date.now();
  const staleBefore = new Date(startedAt - STALE_AFTER_MS);
  // Chosen by when a sync was last ATTEMPTED, not when one last succeeded,
  // and a skipped company has its attempt time bumped (see syncAndAlert).
  // Otherwise lapsed trials and companies that failed would sit at the
  // front of the queue forever and, past 200 of them, crowd out every
  // paying customer. Connections waiting for the customer to reconnect
  // aren't tried at all: nothing works until they do.
  const candidates = await prisma.quickBooksConnection.findMany({
    where: {
      disconnectedAt: null,
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
          ],
        },
        { OR: [{ lastSyncError: null }, { NOT: { lastSyncError: { startsWith: RECONNECT_PREFIX } } }] },
      ],
    },
    orderBy: { lastSyncAttemptAt: { sort: "asc", nulls: "first" } },
    take: 200,
  });

  const results: { connectionId: string; status: string; detail?: string }[] = [];
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      if (Date.now() - startedAt > STOP_STARTING_AFTER_MS) return;
      const connection = candidates[next++];
      results.push(await syncAndAlert(connection));
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  return NextResponse.json({
    ok: true,
    candidates: candidates.length,
    processed: results.length,
    results,
  });
}

async function syncAndAlert(connection: {
  id: string;
  userId: string;
  companyName: string | null;
  alertsEnabled: boolean;
  emailEnabled: boolean;
  emailRecipients: string[];
}) {
  try {
    // Lapsed accounts are not synced: that is paid work, and their tokens
    // are left alone until they come back.
    const entitlements = await getEntitlements(connection.userId);
    if (!entitlements.active) {
      // To the back of the queue until tomorrow.
      await prisma.quickBooksConnection.update({ where: { id: connection.id }, data: { lastSyncAttemptAt: new Date() } });
      return { connectionId: connection.id, status: "skipped", detail: `no active entitlement (${entitlements.access})` };
    }

    await runSyncForConnection(connection.id);

    if (!connection.alertsEnabled || !connection.emailEnabled || connection.emailRecipients.length === 0) {
      return { connectionId: connection.id, status: "synced" };
    }
    const owner = await prisma.user.findUnique({ where: { id: connection.userId }, select: { email: true, emailVerifiedAt: true } });
    const { pending: newAlerts, baseline } = await evaluateAlerts(connection.id);
    if (baseline) return { connectionId: connection.id, status: "synced", detail: "alerts baselined" };
    // Unsent alerts stay pending and go out once the owner has verified.
    if (newAlerts.length === 0 || !owner?.emailVerifiedAt) return { connectionId: connection.id, status: "synced" };

    let sent = 0;
    for (const recipient of connection.emailRecipients) {
      const email = renderAlertEmail({
        connectionId: connection.id,
        companyName: connection.companyName ?? "Your company",
        alerts: newAlerts,
        recipient,
        ownerEmail: owner.email,
      });
      const result = await sendEmail({ to: recipient, subject: email.subject, html: email.html, text: email.text, headers: email.headers });
      if (result.ok) sent++;
    }
    if (sent > 0) await markAlertsSent(newAlerts);
    return { connectionId: connection.id, status: "synced", detail: `${newAlerts.length} alert(s), ${sent} email(s)` };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`nightly-sync: failed for connection ${connection.id}: ${message}`);
    return { connectionId: connection.id, status: "error", detail: message };
  }
}
