/**
 * Small rules the weekly brief job (api/cron/weekly-email) and the nightly
 * job's alert emails (api/cron/nightly-sync) decide by, kept here so they
 * can be tested: a route file may only export its handlers.
 */

/** A sync "in progress" for longer than this was cut off. The sync itself uses the same limit (STALE_SYNC_MINUTES). */
export const STALE_SYNC_MS = 10 * 60_000;

/** A sync that failed, or that has said "in progress" too long to still be running. */
export function syncLooksFailed(
  c: { lastSyncStatus: string | null; lastSyncAttemptAt: Date | null },
  now: number
): boolean {
  if (c.lastSyncStatus === "error") return true;
  return c.lastSyncStatus === "in_progress" && (c.lastSyncAttemptAt == null || now - c.lastSyncAttemptAt.getTime() > STALE_SYNC_MS);
}

/**
 * The sync's stored error, if it's a sentence meant for customers (most
 * are, such as "Your jobs are set to come from QuickBooks Classes, but
 * QuickBooks sent no classes..."). Technical ones (status codes, request
 * ids, network errors) aren't put in an email.
 */
export function customerSyncError(message: string | null | undefined): string | null {
  const m = message?.trim();
  if (!m || m.length > 400) return null;
  if (/intuit_tid|status \d{3}|Change Data Capture|fetch failed|ECONN|ETIMEDOUT|socket|\bundefined\b|\bnull\b/i.test(m)) return null;
  return m;
}

/**
 * How one recipient's profit alert email went: sent (or nothing new to
 * send), worth trying again (the email provider down or busy, or email not
 * set up in this environment), or refused (the address or message was
 * rejected, which trying again won't change).
 */
export function alertSendFailure(result: { ok: boolean; transient?: boolean; skipped?: boolean }): "retry" | "refused" | null {
  if (result.ok) return null;
  return result.transient || result.skipped ? "retry" : "refused";
}

/**
 * The profit alerts that are done: every recipient who can get them has
 * them. One still owed to a recipient whose send may work next time stays
 * waiting, and goes to that recipient alone at the next run (each address
 * gets each alert once; see sendProfitAlerts). An address that was refused
 * doesn't hold an alert back, but one that nobody has received stays
 * waiting. Pure.
 */
export function alertsDelivered(
  alertIds: string[],
  recipients: { has: string[]; failed: "retry" | "refused" | null }[]
): string[] {
  return alertIds.filter((id) => {
    if (!recipients.some((r) => r.has.includes(id))) return false;
    return !recipients.some((r) => r.failed === "retry" && !r.has.includes(id));
  });
}
