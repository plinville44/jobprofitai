import { redirect } from "next/navigation";
import Link from "next/link";
import { getAccount, getActiveConnection } from "@/lib/account";
import { getEntitlements } from "@/lib/entitlements";
import { getConnectionProfitData, laborBurdenOf } from "@/lib/profitability";
import { buildWipSchedule } from "@/lib/wipSchedule";
import { prisma } from "@/lib/prisma";
import { formatCurrency, formatDate } from "@/lib/format";
import PrintButton from "./PrintButton";

export const metadata = { title: "Work in Progress Schedule", robots: { index: false } };

const pct = (n: number | null) => (n == null ? "-" : `${Math.round(n * 1000) / 10}%`);
const money = (n: number | null) => (n == null ? "-" : formatCurrency(n));

/**
 * The Work in Progress schedule laid out the way banks and bonding
 * companies read it: contracts in progress with over and under billings,
 * then contracts completed in the last 12 months. Plain and printable (no
 * app navigation), so "Save as PDF" gives a file to send.
 */
export default async function WipReportPage() {
  const account = await getAccount();
  if (!account) redirect("/login");
  const entitlements = await getEntitlements(account.ownerId);
  if (!entitlements.active) redirect("/dashboard/billing");
  const { connection } = await getActiveConnection(account);
  if (!connection) redirect("/dashboard");

  const now = new Date();
  const [data, filled] = await Promise.all([
    getConnectionProfitData(connection.id, now),
    prisma.job.findMany({ where: { connectionId: connection.id, estimatedCostSource: "target_margin" }, select: { id: true } }),
  ]);
  const s = buildWipSchedule(data.lifetimeJobs, now, new Set(filled.map((j) => j.id)));
  const anyFromTarget = s.inProgress.some((r) => r.costFromTarget);
  const burden = laborBurdenOf(connection);
  const company = connection.companyName ?? "Your company";

  return (
    <main className="mx-auto max-w-6xl bg-white px-6 py-8 text-navy print:max-w-none print:px-0 print:py-0">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href="/dashboard/wip" className="text-sm font-medium text-brand hover:underline">
          Back to WIP
        </Link>
        <div className="flex gap-3">
          <a
            href={`/api/wip/export?connectionId=${encodeURIComponent(connection.id)}`}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-navy hover:bg-gray-50"
          >
            Download CSV
          </a>
          <PrintButton />
        </div>
      </div>

      <header className="border-b border-gray-300 pb-4">
        <h1 className="text-2xl font-bold">{company}</h1>
        <p className="text-lg">Work in Progress Schedule</p>
        <p className="mt-1 text-sm text-gray-600">As of {formatDate(now)}. Prepared from QuickBooks Online data with JobProfitAI. Unaudited.</p>
      </header>

      <section className="mt-6">
        <h2 className="text-base font-semibold">Contracts in progress</h2>
        {s.inProgress.length === 0 ? (
          <p className="mt-2 text-sm text-gray-600">No open jobs have a contract value and a way to measure progress yet.</p>
        ) : (
          <table className="mt-2 w-full border-collapse text-right text-xs">
            <thead>
              <tr className="border-b border-gray-400 align-bottom">
                <th className="py-1 pr-2 text-left font-semibold">Job</th>
                <th className="px-1 py-1 font-semibold">Contract</th>
                <th className="px-1 py-1 font-semibold">Est. total cost</th>
                <th className="px-1 py-1 font-semibold">Est. gross profit</th>
                <th className="px-1 py-1 font-semibold">Cost to date</th>
                <th className="px-1 py-1 font-semibold">% complete</th>
                <th className="px-1 py-1 font-semibold">Earned revenue</th>
                <th className="px-1 py-1 font-semibold">Billed to date</th>
                <th className="px-1 py-1 font-semibold">Over billed</th>
                <th className="px-1 py-1 font-semibold">Under billed</th>
                <th className="px-1 py-1 font-semibold">Cost to complete</th>
                <th className="py-1 pl-1 font-semibold">Gross profit to date</th>
              </tr>
            </thead>
            <tbody>
              {s.inProgress.map((r) => (
                <tr key={r.jobId} className="border-b border-gray-200">
                  <td className="py-1 pr-2 text-left">
                    {r.jobName}
                    {r.customerName ? <span className="block text-[10px] text-gray-500">{r.customerName}</span> : null}
                  </td>
                  <td className="px-1 py-1">{money(r.contract)}</td>
                  <td className="px-1 py-1">
                    {money(r.estimatedTotalCost)}
                    {r.costFromTarget ? "†" : ""}
                  </td>
                  <td className="px-1 py-1">{money(r.estimatedGrossProfit)}</td>
                  <td className="px-1 py-1">{money(r.costToDate)}</td>
                  <td className="px-1 py-1">
                    {pct(r.percentComplete)}
                    {r.percentFromEntry ? "*" : ""}
                  </td>
                  <td className="px-1 py-1">{money(r.earnedRevenue)}</td>
                  <td className="px-1 py-1">{money(r.billedToDate)}</td>
                  <td className="px-1 py-1">{r.overBilled > 0 ? money(r.overBilled) : "-"}</td>
                  <td className="px-1 py-1">{r.underBilled > 0 ? money(r.underBilled) : "-"}</td>
                  <td className="px-1 py-1">{money(r.costToComplete)}</td>
                  <td className="py-1 pl-1">{money(r.grossProfitToDate)}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-gray-500 font-semibold">
                <td className="py-1 pr-2 text-left">Total</td>
                <td className="px-1 py-1">{money(s.totals.contract)}</td>
                <td className="px-1 py-1">{money(s.totals.estimatedTotalCost)}</td>
                <td className="px-1 py-1">{money(s.totals.estimatedGrossProfit)}</td>
                <td className="px-1 py-1">{money(s.totals.costToDate)}</td>
                <td className="px-1 py-1"></td>
                <td className="px-1 py-1">{money(s.totals.earnedRevenue)}</td>
                <td className="px-1 py-1">{money(s.totals.billedToDate)}</td>
                <td className="px-1 py-1">{money(s.totals.overBilled)}</td>
                <td className="px-1 py-1">{money(s.totals.underBilled)}</td>
                <td className="px-1 py-1">{money(s.totals.costToComplete)}</td>
                <td className="py-1 pl-1">{money(s.totals.grossProfitToDate)}</td>
              </tr>
            </tbody>
          </table>
        )}
        <p className="mt-2 text-xs">
          Net {s.totals.overBilled - s.totals.underBilled >= 0 ? "over" : "under"} billed:{" "}
          <strong>{money(Math.abs(s.totals.overBilled - s.totals.underBilled))}</strong>. Over billings are a liability
          (billings in excess of costs and estimated earnings); under billings an asset (costs and estimated earnings in
          excess of billings).
        </p>
      </section>

      <section className="mt-8 break-inside-avoid">
        <h2 className="text-base font-semibold">Contracts completed in the last 12 months</h2>
        {s.completed.length === 0 ? (
          <p className="mt-2 text-sm text-gray-600">No jobs with revenue and costs were completed in the last 12 months.</p>
        ) : (
          <table className="mt-2 w-full border-collapse text-right text-xs">
            <thead>
              <tr className="border-b border-gray-400">
                <th className="py-1 pr-2 text-left font-semibold">Job</th>
                <th className="px-1 py-1 font-semibold">Revenue</th>
                <th className="px-1 py-1 font-semibold">Cost</th>
                <th className="px-1 py-1 font-semibold">Gross profit</th>
                <th className="py-1 pl-1 font-semibold">Margin</th>
              </tr>
            </thead>
            <tbody>
              {s.completed.map((r) => (
                <tr key={r.jobId} className="border-b border-gray-200">
                  <td className="py-1 pr-2 text-left">{r.jobName}</td>
                  <td className="px-1 py-1">{money(r.revenue)}</td>
                  <td className="px-1 py-1">{money(r.cost)}</td>
                  <td className="px-1 py-1">{money(r.grossProfit)}</td>
                  <td className="py-1 pl-1">{pct(r.margin)}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-gray-500 font-semibold">
                <td className="py-1 pr-2 text-left">Total</td>
                <td className="px-1 py-1">{money(s.completedTotals.revenue)}</td>
                <td className="px-1 py-1">{money(s.completedTotals.cost)}</td>
                <td className="px-1 py-1">{money(s.completedTotals.grossProfit)}</td>
                <td className="py-1 pl-1">{pct(s.completedTotals.margin)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </section>

      {s.notScheduled.length > 0 ? (
        <section className="mt-8 break-inside-avoid">
          <h2 className="text-base font-semibold">Open jobs not on the schedule</h2>
          <p className="mt-1 text-xs text-gray-600">
            These need a contract value, and a cost estimate or percent complete, before progress can be measured. Open
            jobs with no cost or invoice in the last 90 days aren&apos;t listed.
          </p>
          <p className="mt-2 text-xs">
            {s.notScheduled.map((j) => `${j.jobName} (${j.needs === "contract" ? "needs a contract value" : "needs a cost estimate or percent complete"})`).join(", ")}
          </p>
        </section>
      ) : null}

      <footer className="mt-8 border-t border-gray-300 pt-3 text-[11px] leading-relaxed text-gray-600">
        <p>
          Percent complete is cost to date divided by the estimated total cost (cost-to-cost). Where cost to date has
          passed the estimate, the estimated total cost is cost to date and the job shows as 100% complete. Where marked *,
          percent complete is the contractor&apos;s own figure, and the estimated total cost is the larger of the estimate
          and what that figure implies (cost to date divided by percent complete). A dash means there isn&apos;t enough to
          work a figure out, and its total is then left blank too.
        </p>
        <p className="mt-2">
          Contract value is the job&apos;s accepted QuickBooks estimates, including change orders; with none accepted, the
          latest pending estimate; or the value entered in JobProfitAI.
          {anyFromTarget
            ? " Where marked †, there was no cost estimate, so one was set from the target margin (the job type's, or the company's); estimated gross profit on those jobs reflects that target rather than a separate estimate, until costs pass it."
            : ""}{" "}
          Revenue excludes sales tax. Costs are those tagged to each job in QuickBooks, with employee time at the pay rate
          on each time entry{burden > 0 ? ` plus a ${Math.round(burden * 1000) / 10}% labor burden` : ""}. Figures come
          from the books as recorded and have not been reviewed or audited.
        </p>
      </footer>
    </main>
  );
}
