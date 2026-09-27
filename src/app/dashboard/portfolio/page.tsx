import { redirect } from "next/navigation";
import Link from "next/link";
import { getAccount, listCompanies } from "@/lib/account";
import { getEntitlements } from "@/lib/entitlements";
import UpgradeRequired from "@/components/dashboard/UpgradeRequired";
import { getPortfolio, portfolioTotals } from "@/lib/portfolio";
import { formatCurrency, formatDate, formatPct } from "@/lib/format";
import OpenCompanyButton from "./OpenCompanyButton";

export const metadata = { title: "Portfolio" };

/**
 * Every QuickBooks company on the account on one page: for a bookkeeper,
 * which clients need attention this week. Owners and team members only; a
 * client's view-only login never sees the other clients.
 */
export default async function PortfolioPage() {
  const account = await getAccount();
  if (!account) redirect("/login");
  if (account.role === "client") redirect("/dashboard");
  const entitlements = await getEntitlements(account.ownerId);
  if (!entitlements.active) return <UpgradeRequired access={entitlements.access} />;

  const companies = await listCompanies(account);
  const now = new Date();
  const rows = await getPortfolio(companies, now);
  const totals = portfolioTotals(rows);
  const needAttention = rows.filter((r) => r.flags.length > 0).length;
  const firm = entitlements.plan === "firm" || entitlements.has("client_logins");

  return (
    <main>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-navy">Portfolio</h1>
          <p className="mt-1 max-w-3xl text-sm text-gray-600">
            Every company on this account, the ones needing attention first. Open one to see its jobs, estimates, money
            owed and opportunities.
          </p>
        </div>
        {account.role === "owner" ? (
          <Link
            href="/dashboard/settings"
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-navy hover:bg-gray-50"
          >
            Connect another company
          </Link>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <p className="mt-8 text-sm text-gray-600">No QuickBooks companies are connected yet. Connect one from Settings.</p>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Tile label="Companies" value={`${rows.length}`} sub={needAttention > 0 ? `${needAttention} need attention` : "none need attention"} />
            <Tile label="Revenue, last 12 months" value={formatCurrency(totals.revenue)} sub={`margin ${formatPct(totals.margin)}`} />
            <Tile label="Unpaid invoices" value={formatCurrency(totals.unpaid)} sub={`${formatCurrency(totals.unpaidOver60)} over 60 days`} />
            <Tile label="Open jobs" value={`${totals.openJobs}`} />
          </div>

          <div className="mt-8 overflow-x-auto rounded-xl border border-gray-200">
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Company</th>
                  <th className="px-3 py-2 text-right font-medium">Revenue (12 mo)</th>
                  <th className="px-3 py-2 text-right font-medium">Margin (12 mo)</th>
                  <th className="px-3 py-2 text-right font-medium">Target</th>
                  <th className="px-3 py-2 text-right font-medium">Open jobs</th>
                  <th className="px-3 py-2 text-right font-medium">Unpaid</th>
                  <th className="px-3 py-2 text-right font-medium">Over 60 days</th>
                  <th className="px-3 py-2 text-right font-medium">Costs on no job</th>
                  <th className="px-3 py-2 font-medium">Needs attention</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((r) => (
                  <tr key={r.connectionId}>
                    <td className="px-3 py-2">
                      <span className="font-medium text-navy">{r.companyName}</span>
                      <span className="block text-xs text-gray-400">
                        {r.lastSyncedAt ? `Synced ${formatDate(r.lastSyncedAt)}` : "Not synced yet"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">{formatCurrency(r.revenue)}</td>
                    <td className={`px-3 py-2 text-right font-medium ${r.belowTarget ? "text-red-700" : "text-navy"}`}>{formatPct(r.margin)}</td>
                    <td className="px-3 py-2 text-right text-gray-500">{r.targetPct != null ? `${r.targetPct}%` : "-"}</td>
                    <td className="px-3 py-2 text-right">{r.openJobs}</td>
                    <td className="px-3 py-2 text-right">{formatCurrency(r.unpaid)}</td>
                    <td className={`px-3 py-2 text-right ${r.unpaidOver60 >= 1 ? "font-medium text-amber-700" : ""}`}>{formatCurrency(r.unpaidOver60)}</td>
                    <td className="px-3 py-2 text-right">{r.untaggedJobCost == null ? "-" : formatCurrency(r.untaggedJobCost)}</td>
                    <td className="px-3 py-2 text-xs text-gray-600">{r.flags.length === 0 ? <span className="text-green-700">Nothing flagged</span> : r.flags.join("; ")}</td>
                    <td className="px-3 py-2 text-right">
                      <OpenCompanyButton connectionId={r.connectionId} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 max-w-4xl text-xs text-gray-500">
            Revenue and margin here are the last 12 months by transaction date (invoices and costs dated in that window,
            labor burden included), for a quick comparison across companies. Each company&apos;s dashboard works margin
            out job by job, so its figures can differ. Unpaid invoices include sales tax, as QuickBooks shows them.
            &ldquo;Costs on no job&rdquo; is job costs from the last 12 months not tagged to any job, from the last full
            sync.
          </p>
          {firm && account.role === "owner" ? (
            <p className="mt-2 text-xs text-gray-500">
              Give a client a view-only login to their own company in{" "}
              <Link href="/dashboard/settings#client-logins" className="text-brand hover:underline">
                Settings, Client logins
              </Link>
              .
            </p>
          ) : null}
        </>
      )}
    </main>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-gray-200 p-4">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="mt-1 text-xl font-bold text-navy">{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-gray-500">{sub}</p> : null}
    </div>
  );
}
