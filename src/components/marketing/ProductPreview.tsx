import { confidenceLabel, formatCurrency, formatDate, formatPct } from "@/lib/format";
import { getSampleCompany, SAMPLE_TARGET_PCT } from "@/lib/sampleCompany";
import { coreCategoryName, GAIN_KINDS, type FeedItem } from "@/lib/opportunities";
import { computeBriefHeadline, snapshotFromFeed } from "@/lib/briefHeadline";

/**
 * Product proof for the marketing site.
 *
 * This is NOT a screenshot and NOT a mockup of something that doesn't exist.
 * It renders the same structures the real app renders - the KPI row, the
 * "Needs Your Attention" table, the Profit Opportunity Feed, the Estimate
 * Check and tracked changes - using the same layout, columns and wording.
 * The feed, estimate and tracking previews are computed by the real engine
 * from an invented company (src/lib/sampleCompany.ts).
 *
 * The numbers are illustrative, and every instance is explicitly labelled
 * "Example" in the UI. That labelling isn't decoration: presenting invented
 * figures as though they were a real customer's results would be a
 * fabricated case study, which is exactly the kind of thing this site
 * deliberately doesn't do.
 */

// Labels and issue wording are copied from the real dashboard and from
// computeNeedsAttentionForJob, and the example jobs agree with the Weekly
// Profit Brief preview below (Harborview is 14% over a $72,600 estimate in
// both). The two previews used to describe the same example company with
// different numbers.
const EXAMPLE_KPIS = [
  { label: "Active Jobs With Activity", value: "18" },
  { label: "Revenue", value: formatCurrency(1_284_500) },
  { label: "Tracked Job Costs", value: formatCurrency(982_140) },
  { label: "Job Gross Profit", value: formatCurrency(302_360) },
  { label: "Average Job Margin", value: "23.5%" },
  { label: "Your Target Margin", value: "28%" },
  { label: "Jobs Below Target", value: "5", tone: "warning" as const },
  { label: "Profit At Risk", value: formatCurrency(58_420), tone: "critical" as const },
];

const EXAMPLE_ATTENTION = [
  {
    job: "Harborview Roof Replacement",
    issue: "Actual costs are 14% over the estimate",
    impact: formatCurrency(10_200),
    severity: "high" as const,
    confidence: "Strong evidence",
  },
  {
    job: "Cedar Ln. Deck Rebuild",
    issue: "Margin has declined over the last several weekly briefs",
    impact: formatCurrency(14_900),
    severity: "high" as const,
    confidence: "Some evidence",
  },
  {
    job: "Riverside HVAC Retrofit",
    issue: "Labor cost is unusually high vs. similar completed jobs",
    impact: formatCurrency(9_260),
    severity: "medium" as const,
    confidence: "Some evidence",
  },
  {
    job: "Oakfield Warehouse Fit-Out",
    issue: "Margin is 6.2 points below your 28% target",
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

// The same example company as the previews above and below: Harborview is
// $100,000 billed and $82,800 spent (17.2%, 14% over its $72,600 estimate),
// Oakfield sits 6.2 points under the 28% target, and Laurel Ave finished at
// 31.4%. Used on /demo so a visitor can see a whole job list, not just the
// attention table.
const EXAMPLE_JOBS = [
  { job: "Harborview Roof Replacement", status: "Active", revenue: 100_000, costs: 82_800, note: "14% over estimate" },
  { job: "Cedar Ln. Deck Rebuild", status: "Active", revenue: 64_000, costs: 52_300, note: "Margin falling" },
  { job: "Oakfield Warehouse Fit-Out", status: "Active", revenue: 206_000, costs: 161_100, note: "Below target" },
  { job: "Riverside HVAC Retrofit", status: "Active", revenue: 88_500, costs: 67_700, note: "Labor running high" },
  { job: "Pine Ridge Addition", status: "Active", revenue: 142_000, costs: 98_700, note: "On target" },
  { job: "Laurel Ave Bath Remodel", status: "Completed", revenue: 54_000, costs: 37_040, note: "On target" },
  { job: "Elm Ct. Siding", status: "Completed", revenue: 31_500, costs: 21_900, note: "On target" },
];

const EXAMPLE_TARGET_MARGIN_PCT = 28;

/** A job list with margin against target, mirroring the real Jobs page. */
export function JobListPreview() {
  return (
    <AppFrame label="Jobs">
      <div className="p-4 sm:p-6">
        <div className="overflow-x-auto rounded-lg border border-jp-line">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead className="bg-jp-surface text-[11px] uppercase tracking-wide text-jp-muted">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-semibold">Job</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">Status</th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">Revenue</th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">Job Costs</th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">Margin</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">Note</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-jp-line">
              {EXAMPLE_JOBS.map((row) => {
                const marginPct = ((row.revenue - row.costs) / row.revenue) * 100;
                const below = marginPct < EXAMPLE_TARGET_MARGIN_PCT;
                return (
                  <tr key={row.job}>
                    <td className="px-4 py-3 font-medium text-jp-ink">{row.job}</td>
                    <td className="px-4 py-3 text-jp-slate">{row.status}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-jp-ink">{formatCurrency(row.revenue)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-jp-ink">{formatCurrency(row.costs)}</td>
                    <td className={`px-4 py-3 text-right font-semibold tabular-nums ${below ? "text-amber-600" : "text-green-700"}`}>
                      {marginPct.toFixed(1)}%
                    </td>
                    <td className="px-4 py-3 text-jp-muted">{row.note}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-jp-muted">
          Margin is colored against a {EXAMPLE_TARGET_MARGIN_PCT}% target margin, which you set in Settings.
        </p>
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

// ---------------------------------------------------------------------------
// Profit Opportunity Feed, Estimate Check and change tracking
// ---------------------------------------------------------------------------
// Rendered from src/lib/sampleCompany.ts, which runs an invented company
// through the real engine. Every figure and sentence below is what the
// product itself produces for that data.

function OpportunityTiles() {
  const { feed } = getSampleCompany();
  const s = feed.summary;
  const tiles = [
    { label: "Profit your pricing left behind", sub: "Finished jobs, last 12 months", value: s.pricingGap, tone: "text-red-600" },
    { label: "At risk on open jobs", sub: "Over estimate or short of target", value: s.openJobRisk, tone: "text-red-600" },
    { label: "Estimates priced too low", sub: "Pending in QuickBooks", value: s.estimatesShortfall, tone: "text-amber-600" },
    { label: "Finished work not billed", sub: "Cash, not profit", value: s.unbilledWork, tone: "text-amber-600" },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-lg border border-jp-line px-3.5 py-3">
          <div className="text-[11px] font-medium uppercase tracking-wide text-jp-muted">{t.label}</div>
          <div className={`mt-1 text-lg font-bold tabular-nums ${t.tone}`}>{formatCurrency(t.value)}</div>
          <div className="text-[11px] text-jp-muted">{t.sub}</div>
        </div>
      ))}
    </div>
  );
}

function OpportunityCard({ item, showWorking = false }: { item: FeedItem; showWorking?: boolean }) {
  const label =
    item.kind === "estimate_below_target"
      ? "Estimate"
      : item.kind === "customer_pricing"
        ? "Customer"
        : item.section === "act_now"
          ? "Open job"
          : "Pricing";
  return (
    <div className="rounded-lg border border-jp-line p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-jp-blue">{label}</p>
          <h3 className="mt-1 text-[15px] font-semibold leading-snug text-jp-ink">{item.title}</h3>
        </div>
        {item.impact != null && (
          <div className="text-right">
            <p className="text-lg font-bold tabular-nums text-red-600">
              {GAIN_KINDS.has(item.kind) ? "+" : ""}
              {formatCurrency(item.impact)}
            </p>
            <p className="text-[11px] text-jp-muted">{item.impactLabel}</p>
          </div>
        )}
      </div>
      <p className="mt-2 text-sm leading-relaxed text-jp-slate">{item.finding}</p>
      {showWorking && item.cause && (
        <p className="mt-2 text-sm leading-relaxed text-jp-slate">
          <span className="font-semibold text-jp-ink">Why: </span>
          {item.cause}
        </p>
      )}
      <p className="mt-2 rounded-md bg-jp-surface-2/70 px-3 py-2 text-sm leading-relaxed text-jp-ink">
        <span className="font-semibold">What to do: </span>
        {item.action}
      </p>
      <p className="mt-2 text-xs text-jp-muted">
        {confidenceLabel(item.confidence)}. {item.confidenceReason}
      </p>
    </div>
  );
}

/** The Profit Opportunity Feed: the headline figures and the top opportunities. */
export function OpportunityFeedPreview({ items = 3 }: { items?: number }) {
  const { feed } = getSampleCompany();
  const pick = [
    feed.items.find((i) => i.kind === "estimate_below_target"),
    feed.items.find((i) => i.kind === "job_type_pricing"),
    feed.items.find((i) => i.kind === "customer_pricing"),
    feed.items.find((i) => i.kind === "open_job_over_estimate"),
  ].filter((i): i is FeedItem => Boolean(i));
  return (
    <AppFrame label="Profit Opportunities">
      <div className="p-4 sm:p-6">
        <OpportunityTiles />
        <div className="mt-5 space-y-4">
          {pick.slice(0, items).map((item) => (
            <OpportunityCard key={item.id} item={item} showWorking={item.kind === "job_type_pricing"} />
          ))}
        </div>
      </div>
    </AppFrame>
  );
}

/** One job type's pricing opportunity, with the part-by-part breakdown behind it. */
export function PricingBreakdownPreview() {
  const { feed } = getSampleCompany();
  const item = feed.items.find((i) => i.kind === "job_type_pricing");
  if (!item) return null;
  return (
    <AppFrame label="Profit Opportunities">
      <div className="p-4 sm:p-6">
        <OpportunityCard item={item} showWorking />
        {item.breakdown && (
          <div className="mt-4 overflow-x-auto rounded-lg border border-jp-line">
            <table className="w-full min-w-[420px] text-left text-sm">
              <thead className="bg-jp-surface text-[11px] uppercase tracking-wide text-jp-muted">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-semibold">Part of the job</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-semibold">Customers paid</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-semibold">It cost</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-semibold">Margin</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-jp-line">
                {item.breakdown.map((b) => (
                  <tr key={b.category}>
                    <td className="px-4 py-2.5 capitalize text-jp-ink">{coreCategoryName(b.category)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-jp-ink">{formatCurrency(b.charged)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-jp-ink">{formatCurrency(b.cost)}</td>
                    <td className={`px-4 py-2.5 text-right font-semibold tabular-nums ${b.marginPct < 0.15 ? "text-red-600" : "text-green-700"}`}>
                      {formatPct(b.marginPct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs leading-relaxed text-jp-muted">
          What customers paid for each part comes from how your QuickBooks estimates split the price, applied to what you
          actually invoiced. What it cost comes from the bills, expenses and timesheets tagged to each job.
        </p>
      </div>
    </AppFrame>
  );
}

/** The Estimate Check on a pending estimate. */
export function EstimateCheckPreview() {
  const { estimates } = getSampleCompany();
  const e = estimates.find((x) => x.check.status === "below_target") ?? estimates[0];
  const c = e.check;
  return (
    <AppFrame label="Estimate Check">
      <div className="p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs text-jp-muted">
              {e.typeLabel} · <span className="font-semibold text-amber-700">{e.notEmailed ? "Not emailed from QuickBooks yet" : "Emailed"}</span>
            </p>
            <h3 className="mt-1 text-base font-semibold text-jp-ink">
              Estimate {e.docNumber} for {e.customerName}
            </h3>
            <p className="mt-0.5 text-sm text-jp-slate">Quoted {formatCurrency(e.amount)} before tax</p>
          </div>
          <div className="text-right">
            <p className="text-lg font-bold tabular-nums text-red-600">{formatCurrency(c.shortfall)} light</p>
            <p className="text-[11px] text-jp-muted">price at target {formatCurrency(c.priceAtTarget)}</p>
          </div>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-jp-slate">{c.summary}</p>
        <div className="mt-3 overflow-x-auto rounded-lg border border-jp-line">
          <table className="w-full min-w-[520px] text-left text-sm">
            <thead className="bg-jp-surface text-[11px] uppercase tracking-wide text-jp-muted">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-semibold">Part of the job</th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">You&rsquo;re charging</th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">Past jobs spent per $1</th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">Price at target</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-jp-line">
              {c.parts.map((p) => (
                <tr key={p.category}>
                  <td className="px-4 py-2.5 capitalize text-jp-ink">{coreCategoryName(p.category)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-jp-ink">{formatCurrency(p.charged)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-jp-ink">${p.costRatio.toFixed(2)}</td>
                  <td
                    className={`px-4 py-2.5 text-right font-semibold tabular-nums ${p.priceAtTarget > p.charged * 1.01 ? "text-red-600" : "text-jp-ink"}`}
                  >
                    {formatCurrency(p.priceAtTarget)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-jp-muted">
          {confidenceLabel(c.confidence)}. {c.confidenceReason} Target {SAMPLE_TARGET_PCT}%.
        </p>
      </div>
    </AppFrame>
  );
}

/** A pricing change being tracked: before and after. */
export function TrackedChangePreview() {
  const { tracked } = getSampleCompany();
  const o = tracked.outcome;
  return (
    <AppFrame label="Changes you're tracking">
      <div className="p-4 sm:p-6">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-jp-muted">
          {tracked.subjectLabel} · since {formatDate(tracked.startedAt)}
        </p>
        <h3 className="mt-1 text-base font-semibold text-jp-ink">{tracked.action}</h3>
        <div className="mt-4 grid grid-cols-3 gap-3">
          <div className="rounded-lg border border-jp-line px-3.5 py-3">
            <div className="text-[11px] uppercase tracking-wide text-jp-muted">Before</div>
            <div className="mt-1 text-lg font-bold tabular-nums text-jp-ink">{formatPct(tracked.baselineMarginPct)}</div>
            <div className="text-[11px] text-jp-muted">{tracked.baselineJobs} finished jobs</div>
          </div>
          <div className="rounded-lg border border-jp-line px-3.5 py-3">
            <div className="text-[11px] uppercase tracking-wide text-jp-muted">Since</div>
            <div className="mt-1 text-lg font-bold tabular-nums text-green-700">{formatPct(o.afterMarginPct)}</div>
            <div className="text-[11px] text-jp-muted">{o.afterJobs} finished jobs</div>
          </div>
          <div className="rounded-lg border border-jp-line px-3.5 py-3">
            <div className="text-[11px] uppercase tracking-wide text-jp-muted">Gross profit</div>
            <div className="mt-1 text-lg font-bold tabular-nums text-green-700">+{formatCurrency(o.extraProfit)}</div>
            <div className="text-[11px] text-jp-muted">vs. the old margin</div>
          </div>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-jp-slate">{o.message}</p>
      </div>
    </AppFrame>
  );
}

/** The Weekly Profit Brief, as it arrives in an inbox. */
/**
 * The Weekly Profit Brief as it actually arrives: the deterministic "What
 * changed" section first, then the written summary. An illustration with
 * made-up jobs, but everything shown is something the real email produces,
 * and the figures are consistent with each other (the Harborview lines
 * imply $100,000 billed, $82,800 spent against a $72,600 estimate).
 *
 * The previous version showed a subject line the email no longer uses, a
 * "profit at risk" total the brief is never given, and a margin "fallen in
 * each of the last three months" that no part of the brief computes.
 */
export function WeeklyBriefPreview() {
  const { feed } = getSampleCompany();
  // As if last week's brief had no open-job risk on file.
  const headline = computeBriefHeadline(snapshotFromFeed(feed), { opportunities: { openRiskByJob: {} } }, "Example Builders");
  return (
    <AppFrame label="Weekly Profit Brief. Monday, 8:00am">
      <div className="p-4 sm:p-6">
        <div className="border-b border-jp-line pb-3">
          <p className="text-xs text-jp-muted">
            <span className="font-medium text-jp-ink">JobProfitAI</span> &lt;noreply@jobprofitai.com&gt;
          </p>
          <p className="mt-1 text-sm font-semibold text-jp-ink">{headline.subject ?? "Example Builders: Weekly Profit Brief"}</p>
        </div>
        <div className="mt-4 rounded-lg border border-jp-line bg-jp-surface px-4 py-3">
          <p className="text-[15px] font-semibold leading-snug text-jp-ink">{headline.headline}</p>
          <ul className="mt-2 space-y-1 text-sm text-jp-slate">
            {headline.snapshot.top.map((t) => (
              <li key={t.title}>
                <span className="font-medium text-jp-ink">{t.title}</span>
                {t.impact != null ? ` (${formatCurrency(t.impact)} ${t.impactLabel})` : ""}
              </li>
            ))}
          </ul>
        </div>
        <div className="mt-4 space-y-3 text-sm leading-relaxed text-jp-slate">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-jp-ink">
              What changed since the brief for the week of Mar 3
            </p>
            <ul className="mt-2 space-y-1">
              <li>
                Harborview Roof Replacement: {formatCurrency(6_800)} in new costs. Margin 24.0% to
                17.2%. Now 14% over its estimate.
              </li>
              <li>Laurel Ave Bath Remodel: Marked completed. Finished at 31.4% margin.</li>
              <li>
                Spruce Ct. Bath: New job, {formatCurrency(18_200)} billed and {formatCurrency(4_650)} in
                costs so far.
              </li>
            </ul>
          </div>
          <p>
            Harborview Roof Replacement is the one to look at. It is now{" "}
            {formatCurrency(10_200)} over its {formatCurrency(72_600)} estimate with the job still
            open. It is still profitable, at 17.2% margin, so this is an overrun to watch, not a
            loss.
          </p>
          <p>
            Two jobs still have no cost estimate on file, so they&rsquo;re left out of the
            over-budget numbers rather than guessed at.
          </p>
        </div>
      </div>
    </AppFrame>
  );
}
