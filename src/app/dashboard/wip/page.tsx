import { redirect } from "next/navigation";
import Link from "next/link";
import { getAccount, getActiveConnection } from "@/lib/account";
import { getEntitlements } from "@/lib/entitlements";
import UpgradeRequired from "@/components/dashboard/UpgradeRequired";
import { getConnectionProfitData } from "@/lib/profitability";
import { NO_VALUE, formatCurrency, formatPct } from "@/lib/format";

/**
 * Work in Progress: the over/under billing schedule contractors, their
 * bookkeepers, banks and bonding companies use, built from data already
 * synced. One row per open job:
 *
 *   percent complete = your own figure (Job Details), or cost to date / estimated cost
 *   earned revenue   = contract value x percent complete
 *   over (under)     = billed to date - earned revenue
 *
 * Jobs missing a contract value, or both an estimated cost and a percent
 * complete, are listed underneath with what they need rather than left out
 * silently.
 */
export default async function WipPage() {
  const account = await getAccount();
  if (!account) redirect("/login");
  const entitlements = await getEntitlements(account.ownerId);
  if (!entitlements.active) return <UpgradeRequired access={entitlements.access} />;

  const { connection } = await getActiveConnection(account.ownerId);
  if (!connection) {
    return (
      <main>
        <h1 className="text-2xl font-bold text-navy">Work in Progress</h1>
        <p className="mt-4 text-gray-600">Connect QuickBooks from the Dashboard to see your work in progress here.</p>
      </main>
    );
  }

  const data = await getConnectionProfitData(connection.id, new Date(), { statusFilter: "open" });
  const canForecast = entitlements.has("forecast_at_completion");
  const open = data.jobs.filter((j) => j.status === "open").sort((a, b) => a.jobName.localeCompare(b.jobName));
  const ready = open.filter((j) => j.wip);
  const notReady = open.filter((j) => !j.wip);

  const sum = (f: (j: (typeof ready)[number]) => number) => ready.reduce((s, j) => s + f(j), 0);
  const totals = {
    contract: sum((j) => j.estimatedRevenue ?? 0),
    cost: sum((j) => j.costs),
    earned: sum((j) => j.wip!.earnedRevenue),
    billed: sum((j) => j.revenue),
    overUnder: sum((j) => j.wip!.overUnderBilling),
  };

  return (
    <main>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-navy">Work in Progress</h1>
          <p className="mt-1 text-sm text-gray-500">
            Over/under billing on every open job at {connection.companyName ?? "this company"}.
          </p>
        </div>
        <a
          href={`/api/wip/export?connectionId=${encodeURIComponent(connection.id)}`}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-navy hover:bg-gray-50"
        >
          Download CSV
        </a>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Tile label="Open jobs on the schedule" value={`${ready.length} of ${open.length}`} />
        <Tile label="Earned revenue" value={formatCurrency(totals.earned)} />
        <Tile label="Billed to date" value={formatCurrency(totals.billed)} />
        <Tile
          label={totals.overUnder >= 0 ? "Net over billed" : "Net under billed"}
          value={formatCurrency(Math.abs(totals.overUnder))}
          tone={totals.overUnder < 0 ? "warning" : undefined}
        />
      </div>

      {ready.length === 0 ? (
        <p className="mt-8 text-sm text-gray-600">
          No open job has what the schedule needs yet: a contract value, plus an estimated cost or a percent complete.
          Add them on each job&apos;s page, or in bulk on the{" "}
          <Link href="/dashboard/jobs" className="text-brand hover:underline">
            Jobs page
          </Link>
          .
        </p>
      ) : (
        <div className="mt-8 overflow-x-auto rounded-xl border border-gray-200">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-3 py-2 font-medium">Job</th>
                <th className="px-3 py-2 text-right font-medium">Contract</th>
                <th className="px-3 py-2 text-right font-medium">Est. cost</th>
                <th className="px-3 py-2 text-right font-medium">Cost to date</th>
                <th className="px-3 py-2 text-right font-medium">% complete</th>
                <th className="px-3 py-2 text-right font-medium">Earned</th>
                <th className="px-3 py-2 text-right font-medium">Billed</th>
                <th className="px-3 py-2 text-right font-medium">Over (under)</th>
                {canForecast ? <th className="px-3 py-2 text-right font-medium">Forecast margin</th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {ready.map((j) => {
                const f = data.forecasts.get(j.jobId);
                return (
                  <tr key={j.jobId}>
                    <td className="px-3 py-2">
                      <Link href={`/dashboard/jobs/${j.jobId}`} className="font-medium text-brand hover:underline">
                        {j.jobName}
                      </Link>
                      {j.customerName ? <span className="block text-xs text-gray-400">{j.customerName}</span> : null}
                    </td>
                    <td className="px-3 py-2 text-right">{formatCurrency(j.estimatedRevenue)}</td>
                    <td className="px-3 py-2 text-right">{j.estimatedCost != null ? formatCurrency(j.estimatedCost) : NO_VALUE}</td>
                    <td className="px-3 py-2 text-right">{formatCurrency(j.costs)}</td>
                    <td className="px-3 py-2 text-right">
                      {Math.round(j.wip!.percentComplete * 100)}%
                      <span className="block text-xs text-gray-400">
                        {j.wip!.percentCompleteSource === "manual" ? "entered" : j.wip!.costPastEstimate ? "cost past estimate" : "by cost"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">{formatCurrency(j.wip!.earnedRevenue)}</td>
                    <td className="px-3 py-2 text-right">{formatCurrency(j.revenue)}</td>
                    <td className={`px-3 py-2 text-right font-medium ${j.wip!.overUnderBilling < 0 ? "text-amber-700" : "text-navy"}`}>
                      {j.wip!.overUnderBilling < 0
                        ? `(${formatCurrency(-j.wip!.overUnderBilling)})`
                        : formatCurrency(j.wip!.overUnderBilling)}
                    </td>
                    {canForecast ? (
                      <td className="px-3 py-2 text-right">
                        {f?.available && f.forecastMarginPct != null ? formatPct(f.forecastMarginPct) : NO_VALUE}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
              <tr className="bg-gray-50 font-semibold">
                <td className="px-3 py-2">Total</td>
                <td className="px-3 py-2 text-right">{formatCurrency(totals.contract)}</td>
                <td className="px-3 py-2 text-right" />
                <td className="px-3 py-2 text-right">{formatCurrency(totals.cost)}</td>
                <td className="px-3 py-2 text-right" />
                <td className="px-3 py-2 text-right">{formatCurrency(totals.earned)}</td>
                <td className="px-3 py-2 text-right">{formatCurrency(totals.billed)}</td>
                <td className="px-3 py-2 text-right">
                  {totals.overUnder < 0 ? `(${formatCurrency(-totals.overUnder)})` : formatCurrency(totals.overUnder)}
                </td>
                {canForecast ? <td /> : null}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-xs text-gray-500">
        Percent complete is your own figure where you&apos;ve entered one (Job Details), otherwise cost to date divided by
        the estimated cost. Where cost has already passed the estimate, cost can&apos;t measure progress any more: enter a
        percent complete for those jobs. Figures exclude sales tax.
        {canForecast ? "" : " Forecast margin at completion is part of Profit Intelligence Pro."}
      </p>

      {notReady.length > 0 ? (
        <section className="mt-8 rounded-xl border border-gray-200 p-5">
          <h2 className="text-sm font-semibold text-navy">Open jobs not on the schedule yet ({notReady.length})</h2>
          <p className="mt-1 text-xs text-gray-500">
            Each needs a contract value (a QuickBooks estimate, or typed in), and an estimated cost or percent complete.
          </p>
          <ul className="mt-3 max-h-64 space-y-1 overflow-y-auto text-sm">
            {notReady.map((j) => (
              <li key={j.jobId} className="flex justify-between gap-3">
                <Link href={`/dashboard/jobs/${j.jobId}`} className="text-brand hover:underline">
                  {j.jobName}
                </Link>
                <span className="text-xs text-gray-500">
                  {j.estimatedRevenue == null ? "needs a contract value" : "needs an estimated cost or percent complete"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: "warning" }) {
  return (
    <div className={`rounded-xl border p-4 ${tone === "warning" ? "border-amber-200 bg-amber-50" : "border-gray-200"}`}>
      <p className="text-xs text-gray-500">{label}</p>
      <p className="mt-1 text-xl font-bold text-navy">{value}</p>
    </div>
  );
}
