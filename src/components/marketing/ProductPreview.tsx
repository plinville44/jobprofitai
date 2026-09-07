import { formatCurrency } from "@/lib/format";

/**
 * Product proof for the marketing site.
 *
 * This is NOT a screenshot and NOT a mockup of something that doesn't exist.
 * It renders the same structures the real Profit Dashboard renders - the KPI
 * row, the "Needs Your Attention" table with its severity and confidence
 * columns, and a Profit Insight card - using the same layout, columns,
 * wording and severity language as src/app/dashboard/page.tsx and
 * src/app/dashboard/intelligence/page.tsx.
 *
 * The numbers are illustrative, and every instance is explicitly labelled
 * "Example" in the UI. That labelling isn't decoration: presenting invented
 * figures as though they were a real customer's results would be a
 * fabricated case study, which is exactly the kind of thing this site
 * deliberately doesn't do.
 */

const EXAMPLE_KPIS = [
  { label: "Active Jobs", value: "18" },
  { label: "Revenue", value: formatCurrency(1_284_500) },
  { label: "Job Costs", value: formatCurrency(982_140) },
  { label: "Gross Profit", value: formatCurrency(302_360) },
  { label: "Avg Job Margin", value: "23.5%" },
  { label: "Your Target Margin", value: "28%" },
  { label: "Jobs Below Target", value: "5", tone: "warning" as const },
  { label: "Profit At Risk", value: formatCurrency(58_420), tone: "critical" as const },
];

const EXAMPLE_ATTENTION = [
  {
    job: "Harborview Roof Replacement",
    issue: "Actual cost is 18% over the estimate with the job still open",
    impact: formatCurrency(21_400),
    severity: "high" as const,
    confidence: "Strong evidence",
  },
  {
    job: "Maple St. Kitchen Remodel",
    issue: "Margin has declined in each of the last three months",
    impact: formatCurrency(14_900),
    severity: "high" as const,
    confidence: "Some evidence",
  },
  {
    job: "Riverside HVAC Retrofit",
    issue: "Labor cost is an outlier versus comparable completed jobs",
    impact: formatCurrency(9_260),
    severity: "medium" as const,
    confidence: "Some evidence",
  },
  {
    job: "Oakfield Warehouse Fit-Out",
    issue: "Below your 28% target margin",
    impact: formatCurrency(12_860),
    severity: "medium" as const,
    confidence: "Strong evidence",
  },
];

const SEVERITY_STYLES = {
  high: "bg-red-50 text-red-700 ring-red-600/20",
  medium: "bg-amber-50 text-amber-800 ring-amber-600/20",
  low: "bg-slate-100 text-slate-700 ring-slate-500/20",
} as const;

function ExampleBadge() {
  return (
    <span className="inline-flex items-center rounded-full bg-jp-surface-2 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-jp-navy ring-1 ring-inset ring-jp-blue/15">
      Example data
    </span>
  );
}

/** Browser-chrome frame so the preview reads as an application screen. */
function AppFrame({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-jp-line bg-white shadow-[0_18px_40px_-24px_rgba(15,31,75,0.35)]">
      <div className="flex items-center justify-between gap-3 border-b border-jp-line bg-jp-surface px-4 py-2.5">
        <div className="flex items-center gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-slate-300" />
          <span className="h-2.5 w-2.5 rounded-full bg-slate-300" />
          <span className="h-2.5 w-2.5 rounded-full bg-slate-300" />
        </div>
        <span className="truncate text-xs font-medium text-jp-muted">{label}</span>
        <ExampleBadge />
      </div>
      {children}
    </div>
  );
}

/** The KPI row + Needs Attention table, mirroring the real Profit Dashboard. */
export function DashboardPreview() {
  return (
    <AppFrame label="Profit Dashboard">
      <div className="p-4 sm:p-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {EXAMPLE_KPIS.map((kpi) => (
            <div key={kpi.label} className="rounded-lg border border-jp-line px-3.5 py-3">
              <div className="text-[11px] font-medium uppercase tracking-wide text-jp-muted">
                {kpi.label}
              </div>
              <div
                className={`mt-1 text-lg font-bold tabular-nums ${
                  kpi.tone === "critical"
                    ? "text-red-600"
                    : kpi.tone === "warning"
                      ? "text-amber-600"
                      : "text-jp-ink"
                }`}
              >
                {kpi.value}
              </div>
            </div>
          ))}
        </div>

        <h3 className="mt-7 text-base font-semibold text-jp-ink">Needs Your Attention</h3>
        <div className="mt-3 overflow-x-auto rounded-lg border border-jp-line">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="bg-jp-surface text-[11px] uppercase tracking-wide text-jp-muted">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-semibold">Job</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">Issue</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">Financial Impact</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">Severity</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">Evidence</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-jp-line">
              {EXAMPLE_ATTENTION.map((row) => (
                <tr key={row.job}>
                  <td className="px-4 py-3 font-medium text-jp-ink">{row.job}</td>
                  <td className="px-4 py-3 text-jp-slate">{row.issue}</td>
                  <td className="px-4 py-3 font-medium tabular-nums text-jp-ink">{row.impact}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset ${SEVERITY_STYLES[row.severity]}`}
                    >
                      {row.severity}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-jp-muted">{row.confidence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppFrame>
  );
}

/**
 * A Profit Insight card, matching the real Finding / Evidence / Impact /
 * Action / Confidence structure that src/lib/intelligence.ts produces and
 * the ProfitInsight table stores.
 */
export function InsightPreview() {
  return (
    <AppFrame label="Profit Intelligence">
      <div className="p-4 sm:p-6">
        <div className="rounded-lg border border-jp-line p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h3 className="text-base font-semibold text-jp-ink">
              Roofing jobs are coming in over estimate by an average of 14%
            </h3>
            <span className="inline-flex items-center rounded-full bg-jp-surface-2 px-2.5 py-0.5 text-xs font-medium text-jp-navy">
              Strong evidence
            </span>
          </div>

          <dl className="mt-4 space-y-3.5 text-sm">
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-jp-muted">
                Evidence
              </dt>
              <dd className="mt-1 leading-relaxed text-jp-slate">
                Across 6 completed roofing jobs, actual cost exceeded the estimate on 5 of them, by
                an average of 14%. Material cost accounts for most of the gap.
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-jp-muted">
                Financial impact
              </dt>
              <dd className="mt-1 font-semibold tabular-nums text-jp-ink">
                {formatCurrency(47_300)} of margin across those jobs
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-jp-muted">
                Recommended action
              </dt>
              <dd className="mt-1 leading-relaxed text-jp-slate">
                Review how material quantities are estimated on roofing work before quoting the next
                one, and check current supplier pricing against the figures your estimates assume.
              </dd>
            </div>
          </dl>
        </div>

        <p className="mt-4 text-xs leading-relaxed text-jp-muted">
          Every insight traces back to the specific jobs behind it. Dollar amounts and confidence
          levels are calculated from your QuickBooks data, not written by the AI.
        </p>
      </div>
    </AppFrame>
  );
}

/** The Weekly Profit Brief, as it arrives in an inbox. */
export function WeeklyBriefPreview() {
  return (
    <AppFrame label="Weekly Profit Brief. Monday, 8:00am">
      <div className="p-4 sm:p-6">
        <div className="border-b border-jp-line pb-3">
          <p className="text-xs text-jp-muted">
            <span className="font-medium text-jp-ink">JobProfitAI</span> &lt;noreply@jobprofitai.com&gt;
          </p>
          <p className="mt-1 text-sm font-semibold text-jp-ink">
            Job Profitability Digest, week of March 3
          </p>
        </div>
        <div className="mt-4 space-y-3 text-sm leading-relaxed text-jp-slate">
          <p>
            The thing worth looking at this week is Harborview Roof Replacement. It&rsquo;s{" "}
            {formatCurrency(21_400)} over its estimate with the job still open, and material costs
            drove almost all of it.
          </p>
          <p>
            Five jobs are running below your 28% target margin, putting about{" "}
            {formatCurrency(58_420)} of expected profit at risk. Maple St. Kitchen Remodel is the one
            trending the wrong way. Its margin has fallen in each of the last three months.
          </p>
          <p>
            Two jobs still have no cost estimate on file, so they&rsquo;re excluded from the
            over-budget numbers rather than guessed at.
          </p>
        </div>
      </div>
    </AppFrame>
  );
}
