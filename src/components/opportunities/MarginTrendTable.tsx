import type { MarginTrend, TypeTrend } from "@/lib/marginTrend";
import { formatPct } from "@/lib/format";

const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" });

/**
 * Margin by job type over the last six months, one column per month, with
 * the change from the three months before to the last three. A month below
 * the type's target is shown in red.
 */
export default function MarginTrendTable({ trend, typeLabel }: { trend: MarginTrend; typeLabel: (key: string) => string }) {
  if (!trend.all) {
    return (
      <p className="mt-3 text-sm text-gray-500">
        This needs at least three jobs finished in the last six months with revenue and costs.
      </p>
    );
  }
  const rows: TypeTrend[] = [trend.all, ...trend.byType];
  return (
    <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="bg-gray-50 text-xs text-gray-500">
          <tr>
            <th className="px-3 py-2 font-medium">Job type</th>
            {trend.months.map((m) => (
              <th key={m} className="px-2 py-2 text-right font-medium">
                {monthLabel(m)}
              </th>
            ))}
            <th className="px-3 py-2 text-right font-medium">Last 3 months vs the 3 before</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r) => (
            <tr key={r.type ?? "all"} className={r.type == null ? "bg-gray-50/60 font-medium" : ""}>
              <td className="px-3 py-2">
                {r.type == null ? "All finished jobs" : typeLabel(r.type)}
                <span className="block text-xs font-normal text-gray-400">
                  {r.jobs} {r.jobs === 1 ? "job" : "jobs"}, {formatPct(r.margin)}
                  {r.targetPct != null ? `, target ${r.targetPct}%` : ""}
                </span>
              </td>
              {r.months.map((c) => {
                const below = r.targetPct != null && c.margin != null && c.margin * 100 < r.targetPct;
                return (
                  <td key={c.month} className="px-2 py-2 text-right">
                    {c.margin == null ? (
                      <span className="text-gray-300">-</span>
                    ) : (
                      <>
                        <span className={below ? "text-red-700" : "text-navy"}>{formatPct(c.margin, 0)}</span>
                        <span className="block text-[10px] text-gray-400">
                          {c.jobs} {c.jobs === 1 ? "job" : "jobs"}
                        </span>
                      </>
                    )}
                  </td>
                );
              })}
              <td className="px-3 py-2 text-right">
                {r.change == null ? (
                  <span className="text-xs text-gray-400">not enough jobs</span>
                ) : Math.abs(r.change) < 0.005 ? (
                  <span className="text-gray-600">about the same</span>
                ) : (
                  <span className={r.change < 0 ? "font-medium text-red-700" : "font-medium text-green-700"}>
                    {r.change < 0 ? "down" : "up"} {(Math.abs(r.change) * 100).toFixed(1)} points
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
