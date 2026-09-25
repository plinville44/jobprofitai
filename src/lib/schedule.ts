/**
 * Time-zone arithmetic for the weekly brief schedule. Pure: every function
 * takes `now` and returns plain values, so the rules are tested directly
 * (src/lib/__tests__/schedule.test.ts).
 *
 * The brief used to be "due" only during the one hour that matched each
 * connection's day and hour. Anything that made that hour's run miss it (a
 * timeout with many customers due at once, an AI outage, a failed sync)
 * meant no brief that week, with nothing to retry it. Now a brief is due
 * from its scheduled time until it has been sent, for up to
 * CATCH_UP_HOURS, and the cron runs every 15 minutes.
 */

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Keep catching up for this long after the scheduled time. */
export const CATCH_UP_HOURS = 48;

interface LocalParts {
  year: number;
  month: number; // 0-11
  day: number;
  weekday: number; // 0 = Sunday
  hour: number;
  minute: number;
}

export function localParts(date: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0; // some runtimes render midnight as "24"
  return {
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10) - 1,
    day: parseInt(get("day"), 10),
    weekday: Math.max(0, WEEKDAYS.indexOf(get("weekday"))),
    hour,
    minute: parseInt(get("minute"), 10),
  };
}

/** Offset of `timeZone` from UTC at `date`, in milliseconds (local - UTC). */
function offsetMs(date: Date, timeZone: string): number {
  const p = localParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month, p.day, p.hour, p.minute);
  return asUtc - Math.floor(date.getTime() / 60_000) * 60_000;
}

/** The instant a local wall-clock time happens in `timeZone` (DST-aware). */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, timeZone: string): Date {
  const guess = Date.UTC(year, month, day, hour);
  let instant = guess - offsetMs(new Date(guess), timeZone);
  // Second pass: the offset at the real instant can differ across a DST change.
  instant = guess - offsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

/** Monday of the local calendar week containing `date`, as UTC midnight of that date. */
export function localWeekStarting(date: Date, timeZone: string): Date {
  const p = localParts(date, timeZone);
  const daysSinceMonday = (p.weekday + 6) % 7;
  return new Date(Date.UTC(p.year, p.month, p.day) - daysSinceMonday * DAY_MS);
}

/**
 * The most recent scheduled send at or before `now`, and the brief week it
 * belongs to.
 *
 * `weekStarting` is the Monday of the local week the send falls in, stored
 * as UTC midnight of that date, which is the same key the rest of the app
 * has always used for WeeklyDigest rows.
 */
export function lastScheduledSend(
  now: Date,
  schedule: { day: number; hour: number; timeZone: string }
): { scheduledAt: Date; weekStarting: Date } {
  const p = localParts(now, schedule.timeZone);
  let daysBack = (p.weekday - schedule.day + 7) % 7;
  if (daysBack === 0 && p.hour < schedule.hour) daysBack = 7;
  const localDate = new Date(Date.UTC(p.year, p.month, p.day) - daysBack * DAY_MS);
  const scheduledAt = zonedTimeToUtc(
    localDate.getUTCFullYear(),
    localDate.getUTCMonth(),
    localDate.getUTCDate(),
    schedule.hour,
    schedule.timeZone
  );
  const weekday = localDate.getUTCDay();
  const weekStarting = new Date(localDate.getTime() - ((weekday + 6) % 7) * DAY_MS);
  return { scheduledAt, weekStarting };
}

/** Whether a brief scheduled at `scheduledAt` should still be sent at `now`. */
export function withinCatchUp(now: Date, scheduledAt: Date): boolean {
  const late = now.getTime() - scheduledAt.getTime();
  return late >= 0 && late <= CATCH_UP_HOURS * 3_600_000;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
