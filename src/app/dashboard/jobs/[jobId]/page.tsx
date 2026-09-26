import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { getAccount } from "@/lib/account";
import { getJobProfitData } from "@/lib/profitability";
import { getEntitlements, requireFeature } from "@/lib/entitlements";
import UpgradeRequired from "@/components/dashboard/UpgradeRequired";
import { NO_VALUE, formatCurrency, formatPct, formatDate, formatShortDate, categoryLabel } from "@/lib/format";
import { ConfidenceBadge, DataQualityBadge, SeverityBadge } from "@/components/dashboard/Badges";
import EstimateVsActualChart from "@/components/charts/EstimateVsActualChart";
import ProfitLeakageChart from "@/components/charts/ProfitLeakageChart";
import MarginTrendChart from "@/components/charts/MarginTrendChart";
import JobEditForm from "@/components/dashboard/JobEditForm";
import { getJobTypes } from "@/lib/jobTypesServer";
import QuickBooksCheck from "@/components/dashboard/QuickBooksCheck";

export default async function JobDetailPage({
  params,
}: {
  // Next.js 16: page params arrive as a Promise.
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;
  const account = await getAccount();
  if (!account) redirect("/login");

  // Server-side entitlement gate. An expired trial gets a proper "choose a
  // plan" screen rather than an authorization error - and because the check
  // happens here, before any financial data is loaded, a lapsed account
  // never has its numbers computed and sent to the browser either.
  const entitlements = await getEntitlements(account.ownerId);
  if (!entitlements.active) {
    return <UpgradeRequired access={entitlements.access} />;
  }

  const data = await getJobProfitData(jobId);
  if (!data || data.connectionUserId !== account.ownerId) notFound();

  // Forecast-at-Completion is a Profit Intelligence feature (see
  // src/lib/entitlements.ts) - gated here, not by hiding the underlying
  // (deterministic, zero-AI) calculation, just its display for accounts
  // without the entitlement.
  const canForecast = Boolean(await requireFeature(account.ownerId, "forecast_at_completion"));

  const f = data.financials;

  return (
    <main>
      <Link href="/dashboard/jobs" className="text-sm text-gray-500 hover:text-navy">
        ← Back to Jobs
      </Link>

      {/* Header */}
      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-navy">{f.jobName}</h1>
          <p className="text-sm text-gray-500">{f.customerName ?? "No customer on file"}</p>
        </div>
        <DataQualityBadge confidence={f.dataConfidence} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <MiniStat label="Status" value={f.status === "open" ? "Active" : "Completed"} />
        <MiniStat label="Revenue" value={formatCurrency(f.revenue)} />
        <MiniStat label="Gross Profit" value={f.profitabilityAvailable ? formatCurrency(f.grossProfit) : NO_VALUE} />
        <MiniStat label="Gross Margin" value={f.profitabilityAvailable ? formatPct(f.grossMarginPct) : NO_VALUE} />
      </div>
      {f.targetMarginPct != null && (
        <p className="mt-2 text-xs text-gray-400">Target margin: {f.targetMarginPct}%</p>
      )}

      <QuickBooksCheck jobId={f.jobId} />

      <JobEditForm
        jobId={f.jobId}
        jobName={f.jobName}
        initialCategory={f.category}
        initialEstimatedCost={f.estimatedCost}
        initialStatusOverride={data.statusOverride}
        initialContractValue={data.manualContractValue}
        syncedContractValue={data.syncedContractValue}
        initialPercentComplete={data.percentCompleteOverride}
        syncedStatus={data.syncedStatus}
        jobTypes={await getJobTypes(data.connectionId)}
      />

      {!f.profitabilityAvailable && (
        <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <strong>Profitability unavailable.</strong> {f.unavailableReason}
        </div>
      )}

      {/* Needs Attention for this job */}
      {data.needsAttention.length > 0 && (
        <div className="mt-6 space-y-2">
          {data.needsAttention.map((item, i) => (
            <div key={i} className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-2.5">
              <div>
                <p className="text-sm text-navy">{item.issue}</p>
                {item.financialImpact != null && (
                  <p className="text-xs text-gray-500">Financial impact: {formatCurrency(item.financialImpact)}</p>
                )}
              </div>
              <SeverityBadge severity={item.severity} />
            </div>
          ))}
        </div>
      )}

      {/* 1. Financial Summary */}
      <Section title="Financial Summary">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Stat label="Revenue" value={formatCurrency(f.revenue)} help="Invoices and sales receipts for this job, less credit memos and refunds, excluding sales tax." />
          <Stat label="Actual Cost" value={formatCurrency(f.costs)} help="Bills, expenses, checks and journal entries tagged to this job, less refunds and vendor credits, plus employee time at each employee's pay rate." />
          {f.estimatedRevenue != null && (
            <Stat
              label="Contract Value"
              value={formatCurrency(f.estimatedRevenue)}
              help={data.manualContractValue != null ? "Typed in Job Details." : "From this job's QuickBooks estimates: accepted ones added together, otherwise the latest pending one."}
            />
          )}
          <Stat
            label="Gross Profit"
            value={f.profitabilityAvailable ? formatCurrency(f.grossProfit) : "Unavailable"}
            help="Revenue minus Actual Cost."
          />
          <Stat
            label="Gross Margin"
            value={f.profitabilityAvailable ? formatPct(f.grossMarginPct) : "Unavailable"}
            help="Gross Profit divided by Revenue."
          />
          {f.fullyLoadedProfit != null && (
            <>
              <Stat
                label="Fully Loaded Profit"
                value={formatCurrency(f.fullyLoadedProfit)}
                help="Gross Profit minus allocated overhead, per your Settings overhead configuration."
              />
              <Stat label="Fully Loaded Margin" value={formatPct(f.fullyLoadedMarginPct)} help="Fully Loaded Profit divided by Revenue." />
            </>
          )}
        </dl>
      </Section>

      {/* 2. Estimate vs Actual */}
      <Section title="Estimate vs. Actual">
        {/* Nothing to plot means no chart. With no estimate and no costs the
            axis rendered as five ticks all reading $0k, which looks like a
            broken chart rather than an empty one. The explanatory line below
            is the honest answer in that case. */}
        {(f.estimatedCost != null || f.costs > 0) && (
          <EstimateVsActualChart
            data={[{ category: "Total", estimated: f.estimatedCost, actual: f.costs }]}
          />
        )}
        {/* Zero costs is not underspending. Variance is costs minus estimate,
            so a job with nothing tagged to it yet read "Running $12,000 under
            the $12,000 estimate" - maximum praise for having no data - two
            lines above "No categorized costs yet". */}
        {f.costs === 0 && f.estimatedCost != null ? (
          <p className="mt-3 text-sm text-gray-600">
            No costs have been tagged to this job yet, so there is nothing to compare against the{" "}
            {formatCurrency(f.estimatedCost)} estimate.
          </p>
        ) : (
          f.varianceVsEstimate != null && (
            <p className="mt-3 text-sm text-gray-600">
              {/* Only a finished job can come in under its estimate. An open
                  job below its estimate simply hasn't finished spending, and
                  "Running $3,500 under" read as good news it wasn't. */}
              {f.varianceVsEstimate > 0
                ? `Running ${formatCurrency(f.varianceVsEstimate)} over the ${formatCurrency(f.estimatedCost)} estimate.`
                : f.status === "open"
                  ? `${formatCurrency(f.costs)} spent so far of the ${formatCurrency(f.estimatedCost)} estimate.`
                  : `Finished ${formatCurrency(Math.abs(f.varianceVsEstimate))} under the ${formatCurrency(f.estimatedCost)} estimate.`}
            </p>
          )
        )}
        {f.estimatedCost == null && <p className="mt-3 text-sm text-gray-500">No cost estimate on file for this job.</p>}
      </Section>

      {/* Work in progress: over/under billing for an open job. */}
      {f.status === "open" && (
        <Section title="Work in Progress">
          {f.wip ? (
            <>
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat
                  label="Percent Complete"
                  value={`${Math.round(f.wip.percentComplete * 100)}%`}
                  help={f.wip.percentCompleteSource === "manual" ? "Entered in Job Details." : "Cost to date divided by the estimated cost."}
                />
                <Stat label="Earned Revenue" value={formatCurrency(f.wip.earnedRevenue)} help="Contract value times percent complete." />
                <Stat label="Billed to Date" value={formatCurrency(f.revenue)} help="Invoices and sales receipts so far, excluding tax." />
                <Stat
                  label={f.wip.overUnderBilling >= 0 ? "Over Billed" : "Under Billed"}
                  value={formatCurrency(Math.abs(f.wip.overUnderBilling))}
                  help="Billed to date minus earned revenue."
                />
              </dl>
              <p className="mt-3 text-sm text-gray-600">
                {f.wip.overUnderBilling >= 0
                  ? `Billed ${formatCurrency(f.wip.overUnderBilling)} ahead of the work done. Good for cash, and a reminder that the remaining work is partly paid for already.`
                  : `About ${formatCurrency(-f.wip.overUnderBilling)} of work is done but not billed yet.`}
                {f.wip.costPastEstimate
                  ? " Cost to date is already past the estimate, so cost can no longer measure progress: enter a percent complete in Job Details for an accurate figure."
                  : f.wip.percentCompleteSource === "cost"
                    ? " Progress is measured by cost against the estimate; enter a percent complete if the work is further along or behind than spending suggests."
                    : ""}
              </p>
            </>
          ) : (
            <p className="text-sm text-gray-500">
              Over/under billing needs a contract value (a QuickBooks estimate, or typed in Job Details) and either an
              estimated cost or a percent complete.
            </p>
          )}
        </Section>
      )}

      {/* 3. Cost Breakdown */}
      <Section title="Cost Breakdown">
        {Object.keys(f.costByCategory).length === 0 ? (
          <p className="text-sm text-gray-500">No categorized costs yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {Object.entries(f.costByCategory)
              .sort(([, a], [, b]) => b - a)
              .map(([category, amount]) => (
                <li key={category} className="flex items-center justify-between py-2 text-sm">
                  <span className="text-gray-600">{categoryLabel(category)}</span>
                  <span className="font-medium text-navy">{formatCurrency(amount)}</span>
                </li>
              ))}
          </ul>
        )}
      </Section>

      {/* 4. Profit Trend (this job's margin over past digests) + Forecast + Leakage */}
      <Section title="Profit Trend">
        {/* Real week labels, and a current point only when there is one.
            The old version labelled the x-axis 1, 2, 3, Now and passed
            `f.grossMarginPct ?? 0`, so a job whose margin cannot be computed
            was drawn as a real 0% - a line falling off a cliff, on a job
            whose own header says profitability is unavailable. */}
        {data.priorMarginPoints.length >= 2 ? (
          <MarginTrendChart
            data={[
              ...data.priorMarginPoints.map((p) => ({
                period: formatShortDate(p.weekStarting),
                marginPct: p.marginPct * 100,
              })),
              { period: "Now", marginPct: f.grossMarginPct == null ? null : f.grossMarginPct * 100 },
            ]}
            targetMarginPct={f.targetMarginPct}
          />
        ) : (
          <p className="text-sm text-gray-500">
            {data.priorMarginPoints.length === 1
              ? "Only one weekly snapshot so far. A trend needs at least two, so this fills in after next week's digest."
              : "No weekly snapshots for this job yet. The Profit Trend fills in as each Weekly Profit Brief is generated."}
          </p>
        )}

        {f.status === "open" && (
          <div className="mt-6 rounded-lg border border-gray-200 p-4">
            <p className="text-sm font-semibold text-navy">Forecast at Completion</p>
            {!canForecast ? (
              <p className="mt-2 text-sm text-gray-500">
                Forecast at Completion is part of Profit Intelligence Pro.{" "}
                <Link href="/dashboard/billing" className="text-brand hover:underline">
                  See plans on the Billing page.
                </Link>
              </p>
            ) : data.forecast.available ? (
              <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <MiniStat label="Actual cost to date" value={formatCurrency(data.forecast.actualCostToDate)} />
                <MiniStat label="Estimated cost" value={data.forecast.estimatedCost != null ? formatCurrency(data.forecast.estimatedCost) : "Not set"} />
                <MiniStat label="Forecast cost at completion" value={formatCurrency(data.forecast.forecastCostAtCompletion)} />
                <MiniStat
                  label="Forecast profit"
                  value={data.forecast.forecastProfit != null ? formatCurrency(data.forecast.forecastProfit) : NO_VALUE}
                />
                <MiniStat
                  label="Forecast margin"
                  value={data.forecast.forecastMarginPct != null ? formatPct(data.forecast.forecastMarginPct) : NO_VALUE}
                />
                <div className="col-span-2 sm:col-span-4">
                  <ConfidenceBadge confidence={data.forecast.confidence ?? "low"} />
                </div>
                <p className="col-span-2 text-xs text-gray-400 sm:col-span-4">
                  {data.forecast.method} The forecast never finishes a job under its estimate; it only warns.
                </p>
              </div>
            ) : (
              <p className="mt-2 text-sm text-gray-500">{data.forecast.reason}</p>
            )}
          </div>
        )}

        {data.leakage && (
          <div className="mt-6">
            <p className="text-sm font-semibold text-navy">Profit Movement (Expected → {f.status === "open" ? "Forecast" : "Actual"})</p>
            <div className="mt-2">
              <ProfitLeakageChart steps={data.leakage} />
            </div>
          </div>
        )}
      </Section>

      {/* 5. Transactions */}
      <Section title="Transactions">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px] text-left text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Category</th>
                <th className="px-3 py-2 font-medium">Description</th>
                <th className="px-3 py-2 font-medium text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.rawCostEntries.slice(0, 50).map((c) => (
                <tr key={c.id}>
                  <td className="px-3 py-2 text-gray-500">{formatDate(c.txnDate)}</td>
                  <td className="px-3 py-2 text-gray-500">{c.qboSourceType}</td>
                  <td className="px-3 py-2 text-gray-600">
                    {categoryLabel(c.category)}
                    {c.accountName ? <span className="block text-xs text-gray-400">{c.accountName}</span> : null}
                  </td>
                  <td className="px-3 py-2 text-gray-600">{c.description ?? NO_VALUE}</td>
                  <td className="px-3 py-2 text-right text-navy">{formatCurrency(c.amount)}</td>
                </tr>
              ))}
              {data.rawInvoices.slice(0, 50).map((i) => (
                <tr key={i.id}>
                  <td className="px-3 py-2 text-gray-500">{formatDate(i.txnDate)}</td>
                  <td className="px-3 py-2 text-gray-500">{revenueLabel(i.qboSourceType, i.status)}</td>
                  <td className="px-3 py-2 text-gray-600">Revenue</td>
                  <td className="px-3 py-2 text-gray-600">
                    {i.taxAmount ? `Excludes ${formatCurrency(Math.abs(i.taxAmount))} sales tax` : NO_VALUE}
                  </td>
                  <td className={`px-3 py-2 text-right ${i.amount < 0 ? "text-red-700" : "text-green-700"}`}>{formatCurrency(i.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.rawCostEntries.length === 0 && data.rawInvoices.length === 0 && (
            <p className="py-4 text-sm text-gray-500">No transactions synced for this job yet.</p>
          )}
          {/* The table stops at 50 of each; Actual Cost and Revenue above
              count everything, so say when rows are hidden. */}
          {data.rawCostEntries.length > 50 || data.rawInvoices.length > 50 ? (
            <p className="pt-3 text-xs text-gray-500">
              Showing the most recent {Math.min(50, data.rawCostEntries.length)} of{" "}
              {data.rawCostEntries.length} costs and {Math.min(50, data.rawInvoices.length)} of{" "}
              {data.rawInvoices.length} invoices. The totals above include all of them.
            </p>
          ) : null}
        </div>
      </Section>

      {/* 6. Data Quality. Lists everything Data Health would say about this
          job, not only the reasons behind the badge. It used to say "No data
          quality issues detected" on a job Data Health listed as stale and a
          flag at the top of this same page called out. */}
      <Section title="Data Quality">
        <div className="flex items-center gap-2">
          <DataQualityBadge confidence={f.dataConfidence} />
        </div>
        {(() => {
          const items = [...f.confidenceReasons];
          if (f.flags.includes("stale_job")) {
            items.push("No costs or invoices synced on this open job in over 30 days.");
          }
          for (const dup of data.possibleDuplicates) {
            items.push(
              `Possible duplicate cost: two different QuickBooks transactions of ${formatCurrency(dup.amount)} on ${dup.date}.`
            );
          }
          return items.length > 0 ? (
            <ul className="mt-3 list-inside list-disc text-sm text-gray-600">
              {items.map((reason, i) => (
                <li key={i}>{reason}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-gray-500">No data quality issues detected for this job.</p>
          );
        })()}
      </Section>
    </main>
  );
}

function revenueLabel(type: string, status: string): string {
  if (type === "SalesReceipt") return "Sales receipt";
  if (type === "CreditMemo") return "Credit memo";
  if (type === "RefundReceipt") return "Refund";
  return `Invoice (${status})`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8 rounded-xl border border-gray-200 p-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function MiniStat({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div>
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-base font-semibold text-navy">{value ?? NO_VALUE}</p>
    </div>
  );
}

function Stat({ label, value, help }: { label: string; value: string; help: string }) {
  return (
    <div title={help}>
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-base font-semibold text-navy">{value}</p>
    </div>
  );
}
