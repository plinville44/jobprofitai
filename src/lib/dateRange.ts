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

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}
function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

export function resolveDateRange(
  rangeKey: string | undefined,
  fromParam: string | undefined,
  toParam: string | undefined,
  now: Date = new Date()
): { range: DateRange; key: RangeKey; label: string } {
  const key: RangeKey = (RANGE_OPTIONS.find((r) => r.key === rangeKey)?.key ?? "last_12_months") as RangeKey;

  if (key === "custom" && fromParam && toParam) {
    const from = new Date(fromParam);
    const to = new Date(toParam);
    if (!isNaN(from.getTime()) && !isNaN(to.getTime())) {
      return { range: { from: startOfDay(from), to: endOfDay(to) }, key, label: "Custom" };
    }
    // fall through to a sane default if the custom dates didn't parse
  }

  switch (key) {
    case "this_month": {
      const from = new Date(now.getFullYear(), now.getMonth(), 1);
      return { range: { from: startOfDay(from), to: endOfDay(now) }, key, label: "This month" };
    }
    case "last_month": {
      const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const to = new Date(now.getFullYear(), now.getMonth(), 0); // day 0 of this month = last day of prior month
      return { range: { from: startOfDay(from), to: endOfDay(to) }, key, label: "Last month" };
    }
    case "quarter": {
      const qStartMonth = Math.floor(now.getMonth() / 3) * 3;
      const from = new Date(now.getFullYear(), qStartMonth, 1);
      return { range: { from: startOfDay(from), to: endOfDay(now) }, key, label: "This quarter" };
    }
    case "year": {
      const from = new Date(now.getFullYear(), 0, 1);
      return { range: { from: startOfDay(from), to: endOfDay(now) }, key, label: "This year" };
    }
    case "last_12_months":
    default: {
      const from = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
      return { range: { from: startOfDay(from), to: endOfDay(now) }, key: "last_12_months", label: "Last 12 months" };
    }
  }
}

export function resolveStatusFilter(statusParam: string | undefined): JobStatusFilter {
  const match = STATUS_OPTIONS.find((s) => s.key === statusParam);
  return match?.key ?? "open"; // default to Active jobs - the common case of "what needs my attention right now"
}
