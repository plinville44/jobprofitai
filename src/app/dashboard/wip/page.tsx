import { redirect } from "next/navigation";
import Link from "next/link";
import { getAccount, getActiveConnection } from "@/lib/account";
import { getEntitlements } from "@/lib/entitlements";
import UpgradeRequired from "@/components/dashboard/UpgradeRequired";
import { getConnectionProfitData } from "@/lib/profitability";
import { buildWipSchedule, NOT_SCHEDULED_NEED_TEXT } from "@/lib/wipSchedule";
import { forecastIsActionable } from "@/lib/forecastRules";
import { prisma } from "@/lib/prisma";
import { NO_VALUE, formatCurrency, formatPct } from "@/lib/format";

/** Brackets for under billing, the way a WIP schedule prints it. */
const overUnder = (n: number) => (n < 0 ? `(${formatCurrency(-n)})` : formatCurrency(n));

/**
 * Work in Progress: the over/under billing schedule contractors, their
 * bookkeepers, banks and bonding companies use, built from data already
 * synced. One row per open job:
 *
 *   percent complete = your own figure (Job Details), or cost to date / estimated cost
 *   earned revenue   = contract value x percent complete
 *   over (under)     = billed to date - earned revenue
 *
 * Built from the same schedule as the bank-ready report and the CSV
 * (buildWipSchedule), so the tiles, the table and the report always agree.
 * Jobs that can't be measured are listed underneath with what they need
 * rather than left out silently.
 */
export default async function WipPage() {
  const account = await getAccount();
  if (!account) redirect("/login");
  const entitlements = await getEntitlements(account.ownerId);
  if (!entitlements.active) return <UpgradeRequired access={entitlements.access} />;

  // A client's view-only login can't mark jobs completed or change estimates.
  const viewOnly = account.role === "client";
  const { connection } = await getActiveConnection(account);
  if (!connection) {
    return (
      <main>
        <h1 className="text-2xl font-bold text-navy">Work in Progress</h1>
        <p className="mt-4 text-gray-600">Connect QuickBooks from the Dashboard to see your work in progress here.</p>
      </main>
    );
  }

  const now = new Date();
  const [data, filled] = await Promise.all([
    getConnectionProfitData(connection.id, now, { statusFilter: "open" }),
    prisma.job.findMany({ where: { connectionId: connection.id, estimatedCostSource: "target_margin" }, select: { id: true } }),
  ]);
  const s = buildWipSchedule(data.lifetimeJobs, now, new Set(filled.map((j) => j.id)));
  const canForecast = entitlements.has("forecast_at_completion");
  const openCount = data.lifetimeJobs.filter((j) => j.status === "open").length;
  const rows = s.inProgress;
  const lifetimeById = new Map(data.lifetimeJobs.map((j) => [j.jobId, j]));
  const t = s.totals;
  const netOverUnder = t.overBilled - t.underBilled;
  const anyLoss = t.provisionForLoss > 0;
  const anyFromTarget = rows.some((r) => r.costFromTarget);
  const anyPastContract = rows.some((r) => r.billedPastContract > 0);

  return (
    <main>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-navy">Work in Progress</h1>
          <p className="mt-1 text-sm text-gray-500">
            Over/under billing on every open job at {connection.companyName ?? "this company"}.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/reports/wip"
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            Bank-ready report
          </Link>
          <a
            href={`/api/wip/export?connectionId=${encodeURIComponent(connection.id)}`}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-navy hover:bg-gray-50"
          >
            Download CSV
          </a>
        </div>
      </div>
      <p className="mt-2 text-xs text-gray-500">
        The bank-ready report lays this out the way banks and bonding companies read a WIP schedule, with totals and
        contracts completed in the last 12 months, ready to print or save as a PDF.
      </p>

      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Tile label="Open jobs on the schedule" value={`${rows.length} of ${openCount}`} />
        <Tile label="Earned revenue" value={formatCurrency(t.earnedRevenue)} />
        <Tile label="Billed to date" value={formatCurrency(t.billedToDate)} />
        <Tile
          label={netOverUnder >= 0 ? "Net over billed" : "Net under billed"}
          value={formatCurrency(Math.abs(netOverUnder))}
          tone={netOverUnder < 0 ? "warning" : undefined}
        />
      </div>

      {rows.length === 0 ? (
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
                <th className="px-3 py-2 text-right font-medium">Est. total cost</th>
                <th className="px-3 py-2 text-right font-medium">Cost to date</th>
                <th className="px-3 py-2 text-right font-medium">% complete</th>
                <th className="px-3 py-2 text-right font-medium">Earned revenue</th>
                <th className="px-3 py-2 text-right font-medium">Billed</th>
                <th className="px-3 py-2 text-right font-medium">Over (under)</th>
                {anyLoss ? <th className="px-3 py-2 text-right font-medium">Loss provision</th> : null}
                {canForecast ? <th className="px-3 py-2 text-right font-medium">Forecast margin</th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => {
                const f = data.forecasts.get(r.jobId);
                const job = lifetimeById.get(r.jobId);
                // Only a forecast firm enough to act on (forecastIsActionable),
                // as on the job page: not one from a small share billed or under
                // 25% complete entered, nor one from billing that's behind the
                // work. This schedule goes to banks.
                const firm = job != null && forecastIsActionable(job, f);
                return (
                  <tr key={r.jobId} className="align-top">
                    <td className="px-3 py-2">
                      <Link href={`/dashboard/jobs/${r.jobId}`} className="font-medium text-brand hover:underline">
                        {r.jobName}
                      </Link>
                      {r.customerName ? <span className="block text-xs text-gray-400">{r.customerName}</span> : null}
                      {r.billedPastContract > 0 ? (
                        <span className="block text-xs text-amber-700">
                          Billed {formatCurrency(r.billedPastContract)} past the contract: record the change order in QuickBooks.
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right">{formatCurrency(r.contract)}</td>
                    <td className="px-3 py-2 text-right">
                      {r.estimatedTotalCost != null ? formatCurrency(r.estimatedTotalCost) : NO_VALUE}
                      {r.costFromTarget ? "†" : ""}
                    </td>
                    <td className="px-3 py-2 text-right">{formatCurrency(r.costToDate)}</td>
                    <td className="px-3 py-2 text-right">
                      {Math.round(r.percentComplete * 100)}%
                      <span className="block text-xs text-gray-400">{r.percentFromEntry ? "entered" : "by cost"}</span>
                    </td>
                    <td className="px-3 py-2 text-right">{formatCurrency(r.earnedRevenue)}</td>
                    <td className="px-3 py-2 text-right">{formatCurrency(r.billedToDate)}</td>
                    <td className={`px-3 py-2 text-right font-medium ${r.underBilled > 0 ? "text-amber-700" : "text-navy"}`}>
                      {overUnder(r.overBilled - r.underBilled)}
                    </td>
                    {anyLoss ? (
                      <td className="px-3 py-2 text-right">{r.provisionForLoss > 0 ? formatCurrency(r.provisionForLoss) : NO_VALUE}</td>
                    ) : null}
                    {canForecast ? (
                      <td className="px-3 py-2 text-right">{firm ? formatPct(f.forecastMarginPct) : NO_VALUE}</td>
                    ) : null}
                  </tr>
                );
              })}
              <tr className="bg-gray-50 font-semibold">
                <td className="px-3 py-2">Total</td>
                <td className="px-3 py-2 text-right">{formatCurrency(t.contract)}</td>
                <td className="px-3 py-2 text-right">{t.estimatedTotalCost != null ? formatCurrency(t.estimatedTotalCost) : NO_VALUE}</td>
                <td className="px-3 py-2 text-right">{formatCurrency(t.costToDate)}</td>
                <td className="px-3 py-2 text-right" />
                <td className="px-3 py-2 text-right">{formatCurrency(t.earnedRevenue)}</td>
                <td className="px-3 py-2 text-right">{formatCurrency(t.billedToDate)}</td>
                <td className="px-3 py-2 text-right">{overUnder(netOverUnder)}</td>
                {anyLoss ? <td className="px-3 py-2 text-right">{formatCurrency(t.provisionForLoss)}</td> : null}
                {canForecast ? <td /> : null}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <section className="mt-4 rounded-xl border border-gray-200 p-4 text-xs leading-relaxed text-gray-600">
        <h2 className="text-sm font-semibold text-navy">How to read this</h2>
        <ul className="mt-2 space-y-1">
          <li>
            <strong>% complete</strong> is your own figure where you&apos;ve entered one (Job Details), otherwise cost to date
            divided by the estimated cost.
          </li>
          <li>
            <strong>Earned revenue</strong> is the part of the contract the work done so far has earned: the contract times
            percent complete.
          </li>
          <li>
            <strong>Over (under)</strong> is billed to date minus earned revenue. A plain figure means you&apos;ve billed ahead
            of the work (over billed): cash in hand for work still to do. A figure in brackets means work is done that
            hasn&apos;t been billed yet (under billed).
          </li>
          <li>
            <strong>Est. total cost</strong> is the job&apos;s cost estimate. Where you&apos;ve entered a percent complete of 25%
            or more, it&apos;s the larger of the estimate and what that percent implies (cost to date divided by it). Under
            25% it&apos;s the estimate; a job under 25% with no estimate, or whose costs have already passed it, is listed
            under the jobs not on the schedule instead.
            {anyFromTarget ? " Marked †: there was no cost estimate, so one was set from your target margin." : ""}
          </li>
          {anyLoss ? (
            <li>
              <strong>Loss provision</strong>: on a job whose estimated total cost is above the contract, the rest of the
              expected loss, booked now in full the way banks and bonding companies expect, not a share at a time as the
              work goes on.
            </li>
          ) : null}
          {anyPastContract ? (
            <li>
              <strong>Billed past the contract</strong>: the schedule keeps the contract from your QuickBooks estimates (or
              the value in Job Details), the more cautious figure for a bank. Billing past it is usually a change order that
              hasn&apos;t been added to the contract yet. Record it in QuickBooks, or update the contract value in Job
              Details, and the schedule picks it up.
              {canForecast ? " Until then the forecast margin uses what's been billed as the contract, so it can differ from this row." : ""}
            </li>
          ) : null}
          <li>
            Figures exclude sales tax.
            {canForecast
              ? " Forecast margin shows a dash where the forecast is too early to trust (little billed, or under 25% complete entered); the job page has the detail."
              : " Forecast margin at completion is part of Profit Intelligence Pro."}
          </li>
        </ul>
      </section>

      {s.notScheduled.length > 0 ? (
        <section className="mt-8 rounded-xl border border-gray-200 p-5">
          <h2 className="text-sm font-semibold text-navy">Open jobs not on the schedule yet ({s.notScheduled.length})</h2>
          <p className="mt-1 text-xs text-gray-500">
            Each needs a contract value (a QuickBooks estimate, or typed in), and an estimated cost or percent complete.
            Once cost to date has passed the estimate, cost can&apos;t measure progress any more, so the job stays off the
            schedule and out of the totals until the estimate is updated or a percent complete is entered.
          </p>
          <ul className="mt-3 max-h-64 space-y-1 overflow-y-auto text-sm">
            {s.notScheduled.map((j) => (
              <li key={j.jobId} className="flex justify-between gap-3">
                <Link href={`/dashboard/jobs/${j.jobId}`} className="text-brand hover:underline">
                  {j.jobName}
                </Link>
                <span className={`text-right text-xs ${j.needs === "estimate_passed" ? "text-amber-700" : "text-gray-500"}`}>
                  {NOT_SCHEDULED_NEED_TEXT[j.needs]}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {s.idle.length > 0 ? (
        <p className="mt-4 text-xs text-gray-500">
          Left off the schedule and its totals: {s.idle.length} open {s.idle.length === 1 ? "job" : "jobs"} with no cost or
          invoice in the last 90 days ({s.idle.slice(0, 10).map((j) => j.jobName).join(", ")}
          {s.idle.length > 10 ? `, and ${s.idle.length - 10} more` : ""}). These are usually finished;
          {viewOnly ? (
            " your bookkeeper can mark them completed."
          ) : (
            <>
              {" "}mark them completed on{" "}
              <Link href="/dashboard/data-health" className="text-brand hover:underline">
                Data Health
              </Link>
              .
            </>
          )}
        </p>
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
