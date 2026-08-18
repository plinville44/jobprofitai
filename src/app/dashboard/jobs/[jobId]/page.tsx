import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { getJobProfitData } from "@/lib/profitability";
import { requireFeature } from "@/lib/entitlements";
import { formatCurrency, formatPct, formatDate, categoryLabel } from "@/lib/format";
import { ConfidenceBadge, SeverityBadge } from "@/components/dashboard/Badges";
import EstimateVsActualChart from "@/components/charts/EstimateVsActualChart";
import ProfitLeakageChart from "@/components/charts/ProfitLeakageChart";
import MarginTrendChart from "@/components/charts/MarginTrendChart";
import JobEditForm from "@/components/dashboard/JobEditForm";

export default async function JobDetailPage({ params }: { params: { jobId: string } }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const data = await getJobProfitData(params.jobId);
  if (!data || data.connectionUserId !== session.userId) notFound();

  // Forecast-at-Completion is a Profit Intelligence feature (see
  // src/lib/entitlements.ts) - gated here, not by hiding the underlying
  // (deterministic, zero-AI) calculation, just its display for accounts
  // without the entitlement.
  const canForecast = Boolean(await requireFeature(session.userId, "forecast_at_completion"));

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
        <ConfidenceBadge confidence={f.dataConfidence} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <MiniStat label="Status" value={f.status === "open" ? "Active" : "Completed"} />
        <MiniStat label="Revenue" value={formatCurrency(f.revenue)} />
        <MiniStat label="Gross Profit" value={f.profitabilityAvailable ? formatCurrency(f.grossProfit) : "—"} />
        <MiniStat label="Gross Margin" value={f.profitabilityAvailable ? formatPct(f.grossMarginPct) : "—"} />
      </div>
      {f.targetMarginPct != null && (
        <p className="mt-2 text-xs text-gray-400">Target margin: {f.targetMarginPct}%</p>
      )}

      <JobEditForm jobId={f.jobId} initialCategory={f.category} initialEstimatedCost={f.estimatedCost} />

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
          <Stat label="Revenue" value={formatCurrency(f.revenue)} help="Sum of paid and open invoices synced from QuickBooks for this job." />
          <Stat label="Actual Cost" value={formatCurrency(f.costs)} help="Sum of all categorized cost entries (Purchases, Bills, time activities) tagged to this job." />
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
        <EstimateVsActualChart
          data={[{ category: "Total", estimated: f.estimatedCost, actual: f.costs }]}
        />
        {f.varianceVsEstimate != null && (
          <p className="mt-3 text-sm text-gray-600">
            {f.varianceVsEstimate > 0
              ? `Running ${formatCurrency(f.varianceVsEstimate)} over the ${formatCurrency(f.estimatedCost)} estimate.`
              : `Running ${formatCurrency(Math.abs(f.varianceVsEstimate))} under the ${formatCurrency(f.estimatedCost)} estimate.`}
          </p>
        )}
        {f.estimatedCost == null && <p className="mt-3 text-sm text-gray-500">No cost estimate on file for this job.</p>}
      </Section>

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
        {data.priorMarginPcts.length >= 2 ? (
          <MarginTrendChart
            data={[...data.priorMarginPcts, f.grossMarginPct ?? 0].map((m, i) => ({
              period: i === data.priorMarginPcts.length ? "Now" : `${i + 1}`,
              marginPct: m * 100,
            }))}
            targetMarginPct={f.targetMarginPct}
          />
        ) : (
          <p className="text-sm text-gray-500">Not enough digest history yet to show a trend for this job.</p>
        )}

        {f.status === "open" && (
          <div className="mt-6 rounded-lg border border-gray-200 p-4">
            <p className="text-sm font-semibold text-navy">Forecast at Completion</p>
            {!canForecast ? (
              <p className="mt-2 text-sm text-gray-500">
                Forecast at Completion is part of Profit Intelligence.{" "}
                <Link href="/dashboard/settings" className="text-brand hover:underline">
                  See your plan in Settings.
                </Link>
              </p>
            ) : data.forecast.available ? (
              <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <MiniStat label="Actual cost to date" value={formatCurrency(data.forecast.actualCostToDate)} />
                <MiniStat label="Estimated cost" value={formatCurrency(data.forecast.estimatedCost)} />
                <MiniStat label="Forecast cost at completion" value={formatCurrency(data.forecast.forecastCostAtCompletion)} />
                <MiniStat
                  label="Forecast profit"
                  value={data.forecast.forecastProfit != null ? formatCurrency(data.forecast.forecastProfit) : "—"}
                />
                <MiniStat
                  label="Forecast margin"
                  value={data.forecast.forecastMarginPct != null ? formatPct(data.forecast.forecastMarginPct) : "—"}
                />
                <div className="col-span-2 sm:col-span-4">
                  <ConfidenceBadge confidence={data.forecast.confidence ?? "low"} />
                </div>
                <p className="col-span-2 text-xs text-gray-400 sm:col-span-4">
                  Forecast assumes the cost overrun observed so far (actual cost ÷ estimated cost) continues at the
                  same rate through the rest of the job. Confidence rises as more of the estimated cost has actually
                  been spent.
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
                  <td className="px-3 py-2 text-gray-600">{categoryLabel(c.category)}</td>
                  <td className="px-3 py-2 text-gray-600">{c.description ?? "—"}</td>
                  <td className="px-3 py-2 text-right text-navy">{formatCurrency(c.amount)}</td>
                </tr>
              ))}
              {data.rawInvoices.slice(0, 50).map((i) => (
                <tr key={i.id}>
                  <td className="px-3 py-2 text-gray-500">{formatDate(i.txnDate)}</td>
                  <td className="px-3 py-2 text-gray-500">Invoice ({i.status})</td>
                  <td className="px-3 py-2 text-gray-600">Revenue</td>
                  <td className="px-3 py-2 text-gray-600">—</td>
                  <td className="px-3 py-2 text-right text-green-700">{formatCurrency(i.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.rawCostEntries.length === 0 && data.rawInvoices.length === 0 && (
            <p className="py-4 text-sm text-gray-500">No transactions synced for this job yet.</p>
          )}
        </div>
      </Section>

      {/* 6. AI Analysis */}
      <Section title="AI Analysis">
        <div className="rounded-lg border border-brand-light bg-blue-50/40 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-brand">AI-generated commentary</p>
          <p className="mt-2 text-sm text-gray-600">
            Detailed AI-written analysis for individual jobs lands with Profit Intelligence (see the project plan) - for
            now, the numbers above are the full picture, all computed directly from your synced QuickBooks data, not by AI.
          </p>
        </div>
      </Section>

      {/* 7. Data Quality */}
      <Section title="Data Quality">
        <div className="flex items-center gap-2">
          <ConfidenceBadge confidence={f.dataConfidence} />
        </div>
        {f.confidenceReasons.length > 0 ? (
          <ul className="mt-3 list-inside list-disc text-sm text-gray-600">
            {f.confidenceReasons.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-gray-500">No data quality issues detected for this job.</p>
        )}
      </Section>
    </main>
  );
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
      <p className="text-base font-semibold text-navy">{value ?? "—"}</p>
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
