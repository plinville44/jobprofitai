/**
 * When a company's daily sync runs.
 *
 * Overnight, in the company's own time zone (its emailTimezone, the one its
 * weekly brief is sent in), so the alert emails a sync sends are waiting in
 * the morning and the website's "after the nightly sync" is true. Before,
 * a company was synced once 20 hours had passed since its last sync, so the
 * time drifted: a Sync now at 10 pm put the next daily sync, and its alerts,
 * at about 6 pm the next evening.
 *
 * A company that misses the window (an outage, a long queue, a sync that
 * failed all night) is synced anyway once it has gone FALLBACK_AFTER_MS
 * without one, at whatever hour that is, so a missed night costs hours, not
 * a day.
 */

/** The overnight window, local hours: from midnight up to (not including) 6 am. */
export const OVERNIGHT_START_HOUR = 0;
export const OVERNIGHT_END_HOUR = 6;

/**
 * Inside the window, a company synced more recently than this waits: it was
 * synced earlier tonight, or by a Sync now late in the evening.
 */
export const MIN_GAP_MS = 6 * 3_600_000;

/** Outside the window, a company this long without a sync is synced anyway. */
export const FALLBACK_AFTER_MS = 30 * 3_600_000;

const DEFAULT_TIME_ZONE = "America/New_York";

/** The hour of the day (0 to 23) at `now` in the given time zone. An unknown zone counts as US Eastern. */
export function localHour(now: Date, timeZone: string | null | undefined): number {
  const read = (zone: string) => {
    const parts = new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: zone }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    return Number.isFinite(hour) ? hour % 24 : null;
  };
  try {
    const h = read(timeZone || DEFAULT_TIME_ZONE);
    if (h != null) return h;
  } catch {
    // An unknown time zone name: fall through to the default.
  }
  return read(DEFAULT_TIME_ZONE) ?? now.getUTCHours();
}

export function inOvernightWindow(now: Date, timeZone: string | null | undefined): boolean {
  const h = localHour(now, timeZone);
  return h >= OVERNIGHT_START_HOUR && h < OVERNIGHT_END_HOUR;
}

/** Whether a company's daily sync is due at `now`. Pure, for tests. */
export function dailySyncDue(
  c: { lastSyncedAt: Date | null; emailTimezone: string | null | undefined },
  now: Date
): boolean {
  if (!c.lastSyncedAt) return true;
  const age = now.getTime() - c.lastSyncedAt.getTime();
  if (age >= FALLBACK_AFTER_MS) return true;
  return age >= MIN_GAP_MS && inOvernightWindow(now, c.emailTimezone);
}
