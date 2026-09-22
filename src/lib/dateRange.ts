import type { DateRange, JobStatusFilter } from "./profitability";

// Parses the dashboard's `?range=&from=&to=&status=` search params into a
// concrete DateRange + label. Kept as plain, dependency-light date math
// (no date-fns needed for this) since the ranges are simple calendar
// calculations - easy to unit test on their own if that becomes useful later.

export type RangeKey = "this_month" | "last_month" | "quarter" | "year" | "last_12_months" | "custom";

export const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "quarter", label: "This quarter" },
  { key: "year", label: "This year" },
  { key: "last_12_months", label: "Last 12 months" },
  { key: "custom", label: "Custom" },
];

export const STATUS_OPTIONS: { key: JobStatusFilter; label: string }[] = [
  { key: "open", label: "Active" },
  { key: "closed", label: "Completed" },
  { key: "all", label: "All" },
];

// All ranges are built as UTC calendar days, because that is how the
// transactions they filter are stored: QuickBooks sends date-only strings
// ("2026-09-01"), which the sync writes as midnight UTC. "Today" is worked
// out in the customer's own timezone first.
//
// This used to use the server's local calendar. On Vercel that is UTC, so
// "This month" rolled over at midnight UTC: a Denver customer looking at the
// dashboard at 7pm on August 31 was shown September, and every tile went to
// near zero. On any non-UTC machine it was worse, because local midnight and
// the stored UTC midnight disagree and a Sep 1 bill fell into August.

const DAY_MS = 86_400_000;

/** Today's calendar date in `timeZone`, as {y, m (0-11), d}. */
function todayIn(now: Date, timeZone: string): { y: number; m: number; d: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).formatToParts(now);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return { y: get("year"), m: get("month") - 1, d: get("day") };
  } catch {
    // An invalid zone string must not take the dashboard down.
    return { y: now.getUTCFullYear(), m: now.getUTCMonth(), d: now.getUTCDate() };
  }
}

const utcDay = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
const endOfUtcDay = (day: Date) => new Date(day.getTime() + DAY_MS - 1);

export function resolveDateRange(
  rangeKey: string | undefined,
  fromParam: string | undefined,
  toParam: string | undefined,
  now: Date = new Date(),
  timeZone: string = "UTC"
): { range: DateRange; key: RangeKey; label: string } {
  const key: RangeKey = (RANGE_OPTIONS.find((r) => r.key === rangeKey)?.key ?? "last_12_months") as RangeKey;
  const { y, m, d } = todayIn(now, timeZone);
  const today = utcDay(y, m, d);

  if (key === "custom" && fromParam && toParam) {
    // Custom dates arrive as YYYY-MM-DD and are read as calendar days, not
    // parsed through the server's local zone.
    const parse = (v: string) => {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
      return match ? utcDay(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
    };
    const from = parse(fromParam);
    const to = parse(toParam);
    if (from && to && from <= to) {
      return { range: { from, to: endOfUtcDay(to) }, key, label: "Custom" };
    }
    // fall through to a sane default if the custom dates didn't parse
  }

  switch (key) {
    case "this_month":
      return { range: { from: utcDay(y, m, 1), to: endOfUtcDay(today) }, key, label: "This month" };
    case "last_month":
      // Day 0 of this month is the last day of the previous one.
      return {
        range: { from: utcDay(y, m - 1, 1), to: endOfUtcDay(utcDay(y, m, 0)) },
        key,
        label: "Last month",
      };
    case "quarter":
      return {
        range: { from: utcDay(y, Math.floor(m / 3) * 3, 1), to: endOfUtcDay(today) },
        key,
        label: "This quarter",
      };
    case "year":
      return { range: { from: utcDay(y, 0, 1), to: endOfUtcDay(today) }, key, label: "This year" };
    case "last_12_months":
    default:
      return {
        range: { from: utcDay(y - 1, m, d), to: endOfUtcDay(today) },
        key: "last_12_months",
        label: "Last 12 months",
      };
  }
}

export function resolveStatusFilter(statusParam: string | undefined): JobStatusFilter {
  const match = STATUS_OPTIONS.find((s) => s.key === statusParam);
  return match?.key ?? "open"; // default to Active jobs - the common case of "what needs my attention right now"
}
