import { confidenceLabel, formatCurrency, formatDate, formatPct } from "@/lib/format";
import { getSampleCompany, SAMPLE_NOW, SAMPLE_TARGET_PCT } from "@/lib/sampleCompany";
import { buildWipSchedule, NOT_SCHEDULED_NEED_TEXT } from "@/lib/wipSchedule";
import { coreCategoryName, GAIN_KINDS, type FeedItem } from "@/lib/opportunities";
import { computeBriefHeadline, snapshotFromFeed } from "@/lib/briefHeadline";
import { jobChangeSentence } from "@/lib/weekOverWeek";

/**
 * Product proof for the marketing site.
 *
 * This is NOT a screenshot and NOT a mockup of something that doesn't exist.
 * It renders the same structures the real app renders - the KPI row, the
 * "Needs Your Attention" table, the Jobs list, the Profit Opportunity Feed,
 * the Estimate Check, tracked changes, the WIP schedule and the Weekly
 * Profit Brief - using the same layout, columns and wording. Every figure,
 * job name and finding is computed by the real engine from an invented
 * company (src/lib/sampleCompany.ts); nothing here is typed by hand except
 * the brief's written summary, which in the product the AI writes, and
 * whose figures here also come from the engine.
 *
 * Every instance is explicitly labelled "Example data" in the UI. That
 * labelling isn't decoration: presenting invented figures as though they
 * were a real customer's results would be a fabricated case study, which is
 * exactly the kind of thing this site deliberately doesn't do.
 */

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

/**
 * The KPI row + Needs Attention table, mirroring the real Profit Dashboard on
 * the All tab for the last 12 months, on Profit Intelligence: the sample company's
 * totals and findings from the real engine (getSampleCompany().dashboard).
 */
export function DashboardPreview() {
  const { dashboard } = getSampleCompany();
  const t = dashboard.totals;
  const kpis: { label: string; value: string; wholeJob?: boolean; tone?: "warning" | "critical" }[] = [
    { label: "Jobs With Activity", value: String(t.jobsInView) },
    { label: "Revenue", value: formatCurrency(t.revenue) },
    { label: "Tracked Job Costs", value: formatCurrency(t.trackedJobCosts) },
    { label: "Job Gross Profit", value: formatCurrency(t.jobGrossProfit) },
    // Named by tab, as on the dashboard: "Margin to Date" on Active, "Job Margin" otherwise.
    { label: dashboard.statusLabel === "open" ? "Margin to Date" : "Job Margin", value: formatPct(t.avgJobMarginPct) },
    { label: "Your Target Margin", value: t.targetMarginPct != null ? `${t.targetMarginPct}%` : "Not set" },
    { label: "Jobs Below Target", value: String(t.jobsBelowTarget), wholeJob: true, tone: t.jobsBelowTarget > 0 ? "warning" : undefined },
    { label: "Profit At Risk", value: formatCurrency(t.profitAtRisk), wholeJob: true, tone: t.profitAtRisk > 0 ? "critical" : undefined },
  ];
  return (
    <AppFrame label="Profit Dashboard">
      <div className="p-4 sm:p-6">
        <p className="mb-3 text-xs text-jp-muted">
          Showing {dashboard.rangeLabel.toLowerCase()}, {dashboard.statusLabel} jobs. The top row follows the period;
          tiles marked &ldquo;whole job&rdquo; and Needs Your Attention cover each job from start to finish.
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {kpis.map((kpi) => (
            <div key={kpi.label} className="rounded-lg border border-jp-line px-3.5 py-3">
              <div className="text-[11px] font-medium uppercase tracking-wide text-jp-muted">
                {kpi.label}
                {kpi.wholeJob ? <span className="ml-1 font-normal normal-case tracking-normal">· whole job</span> : null}
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
              {dashboard.shown.map((row) => (
                <tr key={`${row.jobId}:${row.issueCode}`}>
                  <td className="px-4 py-3 font-medium text-jp-ink">{row.jobName}</td>
                  <td className="px-4 py-3 text-jp-slate">{row.issue}</td>
                  <td className="px-4 py-3 font-medium tabular-nums text-jp-ink">{formatCurrency(row.financialImpact)}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset ${SEVERITY_STYLES[row.severity]}`}
                    >
                      {row.severity}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-jp-muted">{confidenceLabel(row.confidence)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-jp-muted">
          The {dashboard.shown.length} items with the most money at stake, of {dashboard.needsAttention.length}. In the
          app the list runs most serious first, and each job page lists everything for that job.
        </p>
      </div>
    </AppFrame>
  );
}

/**
 * A job list with margin against target, mirroring the real Jobs page: the
 * sample company's open jobs, then its latest finished job of each type
 * (getSampleCompany().jobList), each with what Needs Your Attention says
 * about it.
 *
 * Only finished jobs are judged against the target margin. An open job's
 * margin to date is mostly billing timing, so the product judges open jobs on
 * their estimate (and, on Pro, their forecast) instead.
 */
export function JobListPreview() {
  const { jobList, jobs } = getSampleCompany();
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
                <th scope="col" className="px-4 py-2.5 font-semibold">Needs attention</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-jp-line">
              {jobList.map(({ job, issue }) => {
                const judged = job.status === "closed" && job.targetMarginPct != null && job.grossMarginPct != null;
                const tone = !judged
                  ? "text-jp-ink"
                  : job.grossMarginPct! * 100 < job.targetMarginPct!
                    ? "text-amber-600"
                    : "text-green-700";
                return (
                  <tr key={job.jobId}>
                    <td className="px-4 py-3 font-medium text-jp-ink">{job.jobName}</td>
                    <td className="px-4 py-3 text-jp-slate">{job.status === "open" ? "Active" : "Completed"}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-jp-ink">{formatCurrency(job.revenue)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-jp-ink">{formatCurrency(job.costs)}</td>
                    <td className={`px-4 py-3 text-right font-semibold tabular-nums ${tone}`}>{formatPct(job.grossMarginPct)}</td>
                    <td className="px-4 py-3 text-jp-muted">{issue ?? "Nothing flagged"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-jp-muted">
          {jobList.length} of the {jobs.length} jobs: every open job, then the latest finished job of each type.
          Finished jobs&rsquo; margins are colored against a {SAMPLE_TARGET_PCT}% target margin, which you set in
          Settings. Open jobs are judged on their estimate instead, since margin partway through a job mostly reflects
          when you last billed.
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
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">Usual share of cost</th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">Price at target</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-jp-line">
              {c.parts.map((p) => (
                <tr key={p.category}>
                  <td className="px-4 py-2.5 capitalize text-jp-ink">{coreCategoryName(p.category)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-jp-ink">{formatCurrency(p.charged)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-jp-ink">{Math.round(p.costShare * 100)}%</td>
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

/**
 * The Work in Progress schedule for the sample company, built by the same
 * buildWipSchedule the real report (src/app/reports/wip) uses, with the same
 * column names. Harborview's costs have passed its estimate, so the schedule
 * lists it as needing an updated estimate instead of calling it finished:
 * showing that on the website is part of the point.
 */
export function WipPreview() {
  const { jobs } = getSampleCompany();
  const w = buildWipSchedule(jobs, SAMPLE_NOW);
  const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
  const money = (n: number | null) => (n == null ? "-" : formatCurrency(n));
  const cell = "px-3 py-2.5 text-right tabular-nums";
  return (
    <AppFrame label="Work in Progress Schedule">
      <div className="p-4 sm:p-6">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-jp-muted">Contracts in progress</p>
        <div className="mt-2 overflow-x-auto rounded-lg border border-jp-line">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="bg-jp-surface text-[11px] uppercase tracking-wide text-jp-muted">
              <tr>
                <th scope="col" className="px-3 py-2.5 font-semibold">Job</th>
                <th scope="col" className="px-3 py-2.5 text-right font-semibold">Contract</th>
                <th scope="col" className="px-3 py-2.5 text-right font-semibold">Est. total cost</th>
                <th scope="col" className="px-3 py-2.5 text-right font-semibold">Cost to date</th>
                <th scope="col" className="px-3 py-2.5 text-right font-semibold">% complete</th>
                <th scope="col" className="px-3 py-2.5 text-right font-semibold">Earned revenue</th>
                <th scope="col" className="px-3 py-2.5 text-right font-semibold">Billed to date</th>
                <th scope="col" className="px-3 py-2.5 text-right font-semibold">Over billed</th>
                <th scope="col" className="px-3 py-2.5 text-right font-semibold">Under billed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-jp-line">
              {w.inProgress.map((r) => (
                <tr key={r.jobId}>
                  <td className="px-3 py-2.5 font-medium text-jp-ink">{r.jobName}</td>
                  <td className={`${cell} text-jp-ink`}>{money(r.contract)}</td>
                  <td className={`${cell} text-jp-ink`}>{money(r.estimatedTotalCost)}</td>
                  <td className={`${cell} text-jp-ink`}>{money(r.costToDate)}</td>
                  <td className={`${cell} text-jp-ink`}>{pct(r.percentComplete)}</td>
                  <td className={`${cell} text-jp-ink`}>{money(r.earnedRevenue)}</td>
                  <td className={`${cell} text-jp-ink`}>{money(r.billedToDate)}</td>
                  <td className={`${cell} text-jp-ink`}>{money(r.overBilled)}</td>
                  <td className={`${cell} font-semibold ${r.underBilled > 0 ? "text-amber-700" : "text-jp-ink"}`}>{money(r.underBilled)}</td>
                </tr>
              ))}
              <tr className="bg-jp-surface font-semibold">
                <td className="px-3 py-2.5 text-jp-ink">Total</td>
                <td className={`${cell} text-jp-ink`}>{money(w.totals.contract)}</td>
                <td className={`${cell} text-jp-ink`}>{money(w.totals.estimatedTotalCost)}</td>
                <td className={`${cell} text-jp-ink`}>{money(w.totals.costToDate)}</td>
                <td className={cell} />
                <td className={`${cell} text-jp-ink`}>{money(w.totals.earnedRevenue)}</td>
                <td className={`${cell} text-jp-ink`}>{money(w.totals.billedToDate)}</td>
                <td className={`${cell} text-jp-ink`}>{money(w.totals.overBilled)}</td>
                <td className={`${cell} text-amber-700`}>{money(w.totals.underBilled)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {w.notScheduled.length > 0 && (
          <div className="mt-3 rounded-md bg-jp-surface-2/70 px-3 py-2 text-sm leading-relaxed text-jp-ink">
            <span className="font-semibold">Not on the schedule yet: </span>
            {w.notScheduled.map((j) => `${j.jobName} (${NOT_SCHEDULED_NEED_TEXT[j.needs]})`).join("; ")}.
          </div>
        )}
        <p className="mt-3 text-xs leading-relaxed text-jp-muted">
          Percent complete is cost to date divided by the estimated total cost. Under billed is work done that
          hasn&rsquo;t been billed yet. In the app, the report also lists contracts finished in the last 12 months, and
          prints or saves as a PDF.
        </p>
      </div>
    </AppFrame>
  );
}

/**
 * The Weekly Profit Brief as it actually arrives: the money headline, the
 * deterministic "What changed" section, then the written summary. The
 * headline and "What changed" are the real brief's own calculations
 * (computeBriefHeadline, computeWeekOverWeek, jobChangeSentence) run on the
 * sample company against its previous week (SAMPLE_LAST_BRIEF in
 * src/lib/sampleCompany.ts). In the product the AI writes the summary; here
 * it's an example of one, and every figure in it comes from the engine.
 */
export function WeeklyBriefPreview() {
  const { feed, brief, jobs, jobNames } = getSampleCompany();
  const companyName = "Example Builders";
  const headline = computeBriefHeadline(snapshotFromFeed(feed), brief.priorMetrics, companyName);
  const wow = brief.whatChanged;
  const over = jobs.find((j) => j.status === "open" && j.flags.includes("over_budget_10pct_plus"));
  const unbilled = feed.items.find((i) => i.kind === "underbilled");
  return (
    <AppFrame label="Weekly Profit Brief. Monday, 8:00am">
      <div className="p-4 sm:p-6">
        <div className="border-b border-jp-line pb-3">
          <p className="text-xs text-jp-muted">
            <span className="font-medium text-jp-ink">JobProfitAI</span> &lt;noreply@jobprofitai.com&gt;
          </p>
          <p className="mt-1 text-sm font-semibold text-jp-ink">
            {headline.subject ?? `${companyName}: Weekly Profit Brief, week of ${formatDate(brief.weekStarting)}`}
          </p>
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
          {wow.comparedToWeekStarting && wow.changes.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-jp-ink">
                What changed since the brief for the week of {formatDate(wow.comparedToWeekStarting)}
              </p>
              <ul className="mt-2 space-y-1">
                {wow.changes.slice(0, 8).map((c) => (
                  <li key={c.jobId}>
                    {c.jobName}: {jobChangeSentence(c)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(over || unbilled) && (
            <p className="text-xs font-semibold uppercase tracking-wide text-jp-ink">The summary</p>
          )}
          {over && over.grossMarginPct != null && over.grossMarginPct > 0 && (
            <p>
              {over.jobName} is the one to look at. It is now {formatCurrency(over.varianceVsEstimate)} over its{" "}
              {formatCurrency(over.estimatedCost)} estimate with the job still open. It is still profitable, at{" "}
              {formatPct(over.grossMarginPct)} margin, so this is an overrun to watch, not a loss.
            </p>
          )}
          {unbilled?.impact != null && (
            <p>
              {jobNames[unbilled.jobIds[0]]} has {formatCurrency(unbilled.impact)} of work done that hasn&rsquo;t been
              billed yet, so the next invoice is worth sending.
            </p>
          )}
        </div>
      </div>
    </AppFrame>
  );
}
