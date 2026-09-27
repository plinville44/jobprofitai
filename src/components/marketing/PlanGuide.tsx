import Link from "next/link";
import { PLANS } from "@/lib/plans";

/**
 * Which plan fits, by how many jobs are open at once and how many
 * QuickBooks companies (or whether it's a firm keeping clients' books). Limits come from the plan catalog so this can't
 * drift from what the product enforces.
 */
export default function PlanGuide() {
  const std = PLANS.profit_intelligence;
  const pro = PLANS.profit_intelligence_pro;
  const firm = PLANS.firm;
  const rows = [
    {
      who: `Up to ${std.limits.maxActiveJobs} jobs open at once, one QuickBooks company`,
      examples: "Most remodelers, builders and specialty trades, where a job runs weeks or months.",
      plan: std.name,
      price: std.priceLabel,
    },
    {
      who: `More than ${std.limits.maxActiveJobs} jobs open at once, or 2 to ${pro.limits.maxConnections} companies`,
      examples:
        "Service contractors where every call is its own job, and owners with more than one company. Also the plan with forecasts on jobs in progress.",
      plan: pro.name,
      price: pro.priceLabel,
    },
  ];
  return (
    <div className="mx-auto max-w-4xl">
      <div className="overflow-hidden rounded-xl border border-jp-line bg-white">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Which plan fits, by open jobs and companies</caption>
          <thead>
            <tr className="border-b border-jp-line bg-jp-surface">
              <th scope="col" className="px-5 py-3 font-semibold text-jp-ink">
                If you have
              </th>
              <th scope="col" className="px-5 py-3 font-semibold text-jp-ink">
                Choose
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-jp-line">
            {rows.map((r) => (
              <tr key={r.plan}>
                <td className="px-5 py-4 align-top">
                  <p className="font-medium text-jp-ink">{r.who}</p>
                  <p className="mt-1 text-jp-muted">{r.examples}</p>
                </td>
                <td className="whitespace-nowrap px-5 py-4 align-top">
                  <p className="font-semibold text-jp-ink">{r.plan}</p>
                  <p className="text-jp-muted">{r.price}/month</p>
                </td>
              </tr>
            ))}
            <tr>
              <td className="px-5 py-4 align-top">
                <p className="font-medium text-jp-ink">
                  A bookkeeping or accounting firm with contractor clients, or more than {pro.limits.maxConnections} companies
                </p>
                <p className="mt-1 text-jp-muted">
                  Every client in one login, with a portfolio view and view-only logins for your clients.{" "}
                  <Link href="/pricing#firm" className="font-medium text-jp-blue hover:underline">
                    More about Firm
                  </Link>
                </p>
              </td>
              <td className="whitespace-nowrap px-5 py-4 align-top">
                <p className="font-semibold text-jp-ink">{firm.name}</p>
                <p className="text-jp-muted">
                  {firm.priceLabel} per company/month, {firm.perCompany!.minCompanies} minimum
                </p>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-center text-sm leading-relaxed text-jp-muted">
        Only open jobs count. A job stops counting when you mark it finished, and jobs with no activity in 90 days can be
        marked finished all at once. Not sure how many you have? The trial shows your count on the Billing page before you
        choose.
      </p>
    </div>
  );
}
