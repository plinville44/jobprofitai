import { redirect } from "next/navigation";
import Link from "next/link";
import { getAccount, getActiveConnection } from "@/lib/account";
import { prisma } from "@/lib/prisma";
import { getEntitlements } from "@/lib/entitlements";
import UpgradeRequired from "@/components/dashboard/UpgradeRequired";
import { getConnectionProfitData } from "@/lib/profitability";
import { computeMoneyOwed } from "@/lib/moneyOwed";
import { formatCurrency } from "@/lib/format";

export const metadata = { title: "Money You're Owed" };

/**
 * Cash earned and not collected: unpaid invoices, work done and not billed,
 * and costs past the estimate that may be change orders nobody billed.
 * Read-only toward QuickBooks: bills and invoices are sent from there.
 */
export default async function MoneyOwedPage() {
  const account = await getAccount();
  if (!account) redirect("/login");
  const entitlements = await getEntitlements(account.ownerId);
  if (!entitlements.active) return <UpgradeRequired access={entitlements.access} />;
  const { connection } = await getActiveConnection(account.ownerId);
  if (!connection) {
    return (
      <main>
        <h1 className="text-2xl font-bold text-navy">Money you&apos;re owed</h1>
        <p className="mt-4 text-gray-600">Connect QuickBooks from the Dashboard to see what you&apos;re owed here.</p>
      </main>
    );
  }

  const now = new Date();
  const [profitData, invoices, filled, balancesKnown] = await Promise.all([
    getConnectionProfitData(connection.id, now),
    prisma.invoiceSummary.findMany({
      where: { job: { connectionId: connection.id, missingSince: null }, status: "open", openBalance: { gt: 0 } },
      select: { txnDate: true, openBalance: true, job: { select: { id: true, name: true, customerName: true } } },
    }),
    prisma.job.findMany({ where: { connectionId: connection.id, estimatedCostSource: "target_margin" }, select: { id: true } }),
    // Balances arrive with the sync that stores them; until then open
    // invoices have none, and the page says so rather than showing $0.
    prisma.invoiceSummary.count({ where: { job: { connectionId: connection.id, missingSince: null }, status: "open", openBalance: null } }),
  ]);
  const owed = computeMoneyOwed({
    now,
    openInvoices: invoices.map((i) => ({
      jobId: i.job.id,
      jobName: i.job.name,
      customerName: i.job.customerName,
      txnDate: i.txnDate,
      openBalance: Number(i.openBalance),
    })),
    jobs: profitData.lifetimeJobs,
    targetFilledEstimates: new Set(filled.map((j) => j.id)),
  });

  const tiles = [
    {
      label: "Unpaid invoices",
      value: owed.unpaid.total,
      detail:
        owed.unpaid.invoices === 0
          ? balancesKnown > 0
            ? "Balances appear after the next sync."
            : "Nothing billed is waiting to be paid."
          : `${owed.unpaid.invoices} ${owed.unpaid.invoices === 1 ? "invoice" : "invoices"}${owed.unpaid.over60 > 0 ? `, ${formatCurrency(owed.unpaid.over60)} over 60 days` : ""}.`,
    },
    {
      label: "Work done, not billed",
      value: owed.unbilled.total,
      detail: owed.unbilled.jobs.length === 0 ? "Billing is keeping up with the work." : `On ${owed.unbilled.jobs.length} open ${owed.unbilled.jobs.length === 1 ? "job" : "jobs"}.`,
    },
    {
      label: "Possible change orders",
      value: owed.changeOrders.total,
      detail:
        owed.changeOrders.jobs.length === 0
          ? "No open job is well past its estimate without billing more."
          : "Costs past the estimate, nothing billed past the contract. Not added to the total.",
    },
  ];

  return (
    <main>
      <h1 className="text-2xl font-bold text-navy">Money you&apos;re owed</h1>
      <p className="mt-2 max-w-3xl text-sm text-gray-600">
        Cash you&apos;ve earned and haven&apos;t collected: invoices waiting to be paid, and work done that hasn&apos;t been
        billed yet. Below that, jobs whose costs have run past the estimate while the billing hasn&apos;t, where extra work
        may be a change order nobody billed. JobProfitAI only reads QuickBooks: bill and collect there as usual.
      </p>

      <section className="mt-6 rounded-xl border border-gray-200 bg-white p-5">
        <p className="text-sm text-gray-500">Owed to you now</p>
        <p className="mt-1 text-3xl font-bold text-navy">{formatCurrency(owed.total)}</p>
        <p className="text-xs text-gray-500">Unpaid invoices plus work done and not billed</p>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {tiles.map((t) => (
            <div key={t.label} className="rounded-lg border border-gray-100 p-3">
              <p className="text-xs font-medium text-gray-500">{t.label}</p>
              <p className={`mt-1 text-xl font-bold ${t.value > 0 ? "text-amber-700" : "text-navy"}`}>{formatCurrency(t.value)}</p>
              <p className="mt-1 text-xs text-gray-500">{t.detail}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-navy">Unpaid invoices</h2>
        <p className="mt-1 text-xs text-gray-500">
          Open balances from QuickBooks, including any sales tax, aged from each invoice&apos;s date.
        </p>
        {owed.unpaid.jobs.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500">{balancesKnown > 0 ? "Open invoice balances appear after the next sync." : "No unpaid invoices on your jobs."}</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Job</th>
                  <th className="px-3 py-2 text-right font-medium">Owed</th>
                  <th className="px-3 py-2 text-right font-medium">0-30 days</th>
                  <th className="px-3 py-2 text-right font-medium">31-60</th>
                  <th className="px-3 py-2 text-right font-medium">61-90</th>
                  <th className="px-3 py-2 text-right font-medium">Over 90</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {owed.unpaid.jobs.map((j) => (
                  <tr key={j.jobId}>
                    <td className="px-3 py-2">
                      <Link href={`/dashboard/jobs/${j.jobId}`} className="font-medium text-brand hover:underline">
                        {j.jobName}
                      </Link>
                      {j.customerName ? <span className="block text-xs text-gray-500">{j.customerName}</span> : null}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold">{formatCurrency(j.balance)}</td>
                    {j.buckets.map((b, i) => (
                      <td key={i} className={`px-3 py-2 text-right ${b > 0 && i >= 2 ? "text-red-700" : "text-gray-700"}`}>
                        {b > 0 ? formatCurrency(b) : "-"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-navy">Work done, not billed</h2>
        <p className="mt-1 text-xs text-gray-500">
          Contract times percent complete, less what&apos;s been billed. Percent complete is your own where you&apos;ve
          entered one on the job, otherwise cost to date against the cost estimate. The same figures as the WIP report.
        </p>
        {owed.unbilled.jobs.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500">
            Nothing to bill: every open job with a contract value is billed about as far as the work has gone.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white">
            {owed.unbilled.jobs.map((j) => (
              <li key={j.jobId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div>
                  <Link href={`/dashboard/jobs/${j.jobId}`} className="font-medium text-brand hover:underline">
                    {j.jobName}
                  </Link>
                  <p className="text-xs text-gray-500">
                    About {Math.round(j.percentComplete * 100)}% complete{j.percentCompleteSource === "manual" ? " (your figure)" : ""},{" "}
                    {formatCurrency(j.billed)} billed of a {formatCurrency(j.contract)} contract.
                  </p>
                </div>
                <p className="text-lg font-bold text-amber-700">{formatCurrency(j.amount)}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-navy">Possible change orders</h2>
        <p className="mt-1 text-xs text-gray-500">
          Open jobs whose costs are more than 10% past their cost estimate while nothing has been billed past the
          contract. If the extra was work outside the original scope, bill it as a change order; if it wasn&apos;t, it&apos;s
          an overrun, and the job page shows where it went.
        </p>
        {owed.changeOrders.jobs.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500">None right now.</p>
        ) : (
          <ul className="mt-3 divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white">
            {owed.changeOrders.jobs.map((j) => (
              <li key={j.jobId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div>
                  <Link href={`/dashboard/jobs/${j.jobId}`} className="font-medium text-brand hover:underline">
                    {j.jobName}
                  </Link>
                  <p className="text-xs text-gray-500">
                    {formatCurrency(j.costs)} spent against a {formatCurrency(j.estimatedCost)} estimate;{" "}
                    {formatCurrency(j.billed)} billed of a {formatCurrency(j.contract)} contract.
                    {j.priceAtTarget != null ? ` At your target margin, that extra would bill at about ${formatCurrency(j.priceAtTarget)}.` : ""}
                  </p>
                </div>
                <p className="text-lg font-bold text-navy">{formatCurrency(j.overBy)} over</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
