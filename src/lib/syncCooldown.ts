/**
 * A short pause between one company's syncs when someone clicks Sync now.
 *
 * Sync now always does a full read of the company's QuickBooks data (see
 * api/quickbooks/sync), so clicking it again the moment one finishes repeats
 * the whole read for nothing and spends the company's QuickBooks API
 * allowance. A sync that is still running is already refused
 * (SyncAlreadyRunningError); this covers the one that has just ended, whether
 * it worked or failed, and whether a person or the nightly job started it.
 *
 * Not while a rebuild is waiting: a change of job setup (the dashboard's
 * "Is each job a Class?" answer, or Settings) asks for a full read straight
 * away, and the sync that ended a moment ago read the old setup. The
 * dashboard question is only shown after a sync has finished, so without
 * this its "Yes" nearly always landed inside the pause.
 */

export const SYNC_COOLDOWN_SECONDS = 60;

/**
 * Seconds until Sync now may run again for a company, or 0 when it may run
 * now. A sync still marked in progress isn't this rule's business. Pure.
 *
 * `lastSyncStartedAt` is when the company's most recent sync started (its
 * newest SyncRun). A rebuild asked for after that start is still waiting:
 * no sync has read the new setup yet. Unknown (no sync recorded) counts as
 * waiting too.
 */
export function syncCooldownSecondsLeft(
  connection: {
    lastSyncAttemptAt: Date | null;
    lastSyncStatus: string | null;
    rebuildRequestedAt?: Date | null;
    lastSyncStartedAt?: Date | null;
  },
  now: Date = new Date()
): number {
  if (!connection.lastSyncAttemptAt || connection.lastSyncStatus === "in_progress") return 0;
  if (rebuildWaiting(connection)) return 0;
  const elapsedMs = now.getTime() - connection.lastSyncAttemptAt.getTime();
  // A clock that went backwards reads as "just now": wait the full cooldown.
  const left = Math.ceil((SYNC_COOLDOWN_SECONDS * 1000 - Math.max(0, elapsedMs)) / 1000);
  return Math.max(0, left);
}

/** A rebuild was asked for after the last sync started, so no sync has done it yet. */
export function rebuildWaiting(c: { rebuildRequestedAt?: Date | null; lastSyncStartedAt?: Date | null }): boolean {
  if (!c.rebuildRequestedAt) return false;
  return !c.lastSyncStartedAt || c.rebuildRequestedAt.getTime() > c.lastSyncStartedAt.getTime();
}

/** What the person sees when they click too soon. */
export function syncCooldownMessage(secondsLeft: number): string {
  const wait = secondsLeft <= 1 ? "a second" : `${secondsLeft} seconds`;
  return `This company finished syncing less than a minute ago. Try again in ${wait}.`;
}
