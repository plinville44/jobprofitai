import { redirect } from "next/navigation";
import Link from "next/link";
import { getAccount, getActiveConnection } from "@/lib/account";
import { getEntitlements } from "@/lib/entitlements";
import UpgradeRequired from "@/components/dashboard/UpgradeRequired";
import { getOpportunityData, estimateLabel, type CheckedEstimate } from "@/lib/opportunityData";
import { selectableJobTypes } from "@/lib/jobTypes";
import { coreCategoryName, fmtTarget } from "@/lib/opportunities";
import { categoryLabel, formatCurrency, formatDate, formatPct } from "@/lib/format";
import { ConfidenceBadge } from "@/components/dashboard/Badges";
import EstimateTypeSelect from "@/components/opportunities/EstimateTypeSelect";

export const metadata = { title: "Estimate Check" };

/**
 * Estimate Check: every pending QuickBooks estimate, judged against what the
 * company's own finished jobs of the same type actually cost for each dollar
 * charged. Read-only toward QuickBooks: the contractor changes the estimate
 * there.
 */
export default async function EstimatesPage() {
  const account = await getAccount();
  if (!account) redirect("/login");
  const entitlements = await getEntitlements(account.ownerId);
  if (!entitlements.active) return <UpgradeRequired access={entitlements.access} />;
  const { connection } = await getActiveConnection(account);
  if (!connection) {
    return (
      <main>
        <h1 className="text-2xl font-bold text-navy">Estimate Check</h1>
        <p className="mt-4 text-gray-600">Connect QuickBooks from the Dashboard to check your estimates here.</p>
      </main>
    );
  }
  if (!entitlements.has("profit_opportunities")) {
    return (
      <main>
        <h1 className="text-2xl font-bold text-navy">Estimate Check</h1>
        <p className="mt-4 text-sm text-gray-600">
          The Estimate Check isn&apos;t part of your plan.{" "}
          <Link href="/dashboard/billing" className="font-medium text-brand hover:underline">
            See plans
          </Link>
          .
        </p>
      </main>
    );
  }

  const data = await getOpportunityData(connection.id);
  const options = selectableJobTypes(data.jobTypes).map((t) => ({ value: t.value, label: t.label }));
  const flagged = data.estimates.filter((e) => e.check.status === "below_target");

  return (
    <main>
      <h1 className="text-2xl font-bold text-navy">Estimate Check</h1>
      <p className="mt-2 max-w-3xl text-sm text-gray-600">
        Your pending QuickBooks estimates, checked against what your own finished jobs of the same type actually cost
        for every dollar you charged. Catch a thin price before it goes out, not after the job is done.
      </p>
      <p className="mt-2 text-xs text-gray-500">
        {data.estimates.length === 0
          ? ""
          : `${data.estimates.length} pending ${data.estimates.length === 1 ? "estimate" : "estimates"} from the last 6 months, ${flagged.length} below target. `}
        JobProfitAI only reads QuickBooks. To change a price, edit the estimate in QuickBooks; it updates here on the next sync.
      </p>

      {data.estimates.length === 0 ? (
        <div className="mt-6 rounded-xl border border-gray-200 bg-gray-50 p-6 text-sm text-gray-600">
          No pending estimates in QuickBooks from the last six months. When you create one, it shows up here after the
          next sync with a check against your finished jobs.
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          {data.estimates.map((e) => (
            <EstimateCard key={e.id} e={e} options={options} readOnly={account.role === "client"} />
          ))}
        </div>
      )}

      <section className="mt-10 rounded-xl border border-gray-200 p-5 text-xs text-gray-600">
        <h2 className="text-sm font-semibold text-navy">How the check works</h2>
        <p className="mt-2">
          When an estimate&apos;s lines carry quantities, those lines are costed directly: products and services at the
          purchase cost set on them in QuickBooks (labor ones plus any labor burden set in Settings, shown as &ldquo;item
          cost plus burden&rdquo;), and hours on labor lines at your average labor cost per hour (from time entries, plus
          any labor burden). When labor from time entries is turned off in Settings, no burden is added and hours on
          labor lines aren&apos;t costed. A line priced as a lump sum,
          rather than per hour or per unit,
          isn&apos;t counted, and neither is a material or other non-labor item priced at more than three times its
          purchase cost: that&apos;s usually sold installed, and its item cost leaves the labor out. Then the check follows this job&apos;s own price and scope. When every line can be costed
          that way, no past jobs are needed. When at least half the price can, the rest is checked at your past jobs&apos;
          rate, which needs three finished jobs of the type. Each estimate shows how every line was read, so you can
          see if one was read the wrong way.
        </p>
        <p className="mt-2">
          Quantities only say what each line is read as. When you have at least three finished jobs of the type and the
          quantities come out more than 15 points above them, the usual cause is a line read the wrong way: an installed
          price costed at a materials-only item cost, or labor priced by the square or by the day read as hours. Then the
          check goes by the lower figure, your past jobs, marks it low confidence and says so.
        </p>
        <p className="mt-2">
          Otherwise we take your finished jobs of the same type from the last two years, work out what they cost for
          every dollar you charged, and apply that to the estimate&apos;s price. At one rate, any price comes out at the
          same margin, so that check tells you whether your pricing for that type of job reaches your target, not whether
          one job is priced right for its size. The price at
          target is what the expected cost needs to sell for to hit your target margin for that job type.
        </p>
        <p className="mt-2">
          When your estimates list labor, materials, subcontractors and equipment on separate lines, each using its own
          product or service, and at least three finished jobs of the type did too, each line is also set against how
          the cost of those jobs usually splits. That shows which line is thin compared with the others.
        </p>
        <p className="mt-2">
          It needs at least three finished jobs of the type with revenue and costs. It says what happened on your past
          jobs; a job that&apos;s genuinely different from them won&apos;t follow it.
        </p>
      </section>
    </main>
  );
}

function EstimateCard({ e, options, readOnly }: { e: CheckedEstimate; options: { value: string; label: string }[]; readOnly: boolean }) {
  const c = e.check;
  const below = c.status === "below_target";
  const ok = c.status === "on_target";
  return (
    <article
      id={`estimate-${e.id}`}
      className={`rounded-xl border bg-white p-5 ${below ? "border-red-200" : ok ? "border-green-200" : "border-gray-200"}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-gray-500">
            {formatDate(e.txnDate)}
            {e.expirationDate ? ` · expires ${formatDate(e.expirationDate)}` : ""} ·{" "}
            <span className={e.notEmailed ? "font-semibold text-amber-700" : ""}>{e.notEmailed ? "Not emailed from QuickBooks yet" : "Emailed from QuickBooks"}</span>
          </p>
          <h2 className="mt-1 text-base font-semibold text-navy">{estimateLabel(e)}</h2>
          <p className="mt-1 text-sm text-gray-600">
            Quoted {formatCurrency(e.amount)} before tax
            {e.jobId ? (
              <>
                {" "}
                on{" "}
                <Link href={`/dashboard/jobs/${e.jobId}`} className="text-brand hover:underline">
                  {e.jobName}
                </Link>
              </>
            ) : null}
          </p>
        </div>
        <div className="text-right">
          {below ? (
            <>
              <p className="text-xl font-bold text-red-700">{(c.shortfall ?? 0) >= 1 ? `${formatCurrency(c.shortfall)} light` : "Just below target"}</p>
              <p className="text-xs text-gray-500">price at target {formatCurrency(c.priceAtTarget)}</p>
            </>
          ) : ok ? (
            <p className="text-sm font-semibold text-green-700">At or above target</p>
          ) : (
            <p className="text-sm font-medium text-gray-500">Not checked yet</p>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-gray-700">
        <span className="font-medium text-navy">Job type:</span>
        {e.typeSource === "job" || readOnly ? (
          <span>
            {e.typeLabel} {e.typeSource === "job" ? <span className="text-xs text-gray-500">(from the job)</span> : null}
          </span>
        ) : (
          <>
            <EstimateTypeSelect estimateId={e.id} value={e.typeSource === "chosen" ? e.typeKey : null} options={options} />
            {e.typeSource === "suggested" && (
              <span className="text-xs text-gray-500">
                Checked as {e.typeLabel} for now. {e.typeReason} Choose a type to confirm it.
              </span>
            )}
          </>
        )}
      </div>

      <p className="mt-3 text-sm text-gray-700">{c.summary}</p>
      {c.lineReadings.length > 0 && (
        <div className="mt-3 max-w-4xl overflow-x-auto">
          <p className="text-xs font-medium text-gray-600">
            {c.readingsUnused
              ? unusedReadingsText(c.lineReadings)
              : c.quantityMarginOverruled != null
              ? `How each line was read from its quantity. Costed this way the estimate comes to ${formatPct(c.quantityMarginOverruled)}, which is why it was set aside; a line read the wrong way usually explains it.`
              : "How each line was read from its quantity. If a line was read the wrong way (a price per square or per day read as hours, or an installed price costed as materials only), the result above is off too."}
          </p>
          <table className="mt-1 w-full text-left text-sm">
            <thead className="text-xs text-gray-500">
              <tr>
                <th className="py-1 pr-3 font-medium">Line</th>
                <th className="py-1 pr-3 font-medium">How it was read</th>
                <th className="py-1 pr-3 font-medium">Cost</th>
                <th className="py-1 font-medium">You&apos;re charging</th>
              </tr>
            </thead>
            <tbody>
              {c.lineReadings.map((l, i) => {
                // Red when the costed part of the line doesn't reach the target on its own cost.
                const thin = l.cost != null && l.costedPrice < l.cost / (1 - (c.targetMarginPct ?? 0));
                return (
                  <tr key={i} className="border-t border-gray-100 align-top">
                    <td className="py-1.5 pr-3">{l.name ?? coreCategoryName(l.category)}</td>
                    <td className={`py-1.5 pr-3 text-xs ${l.cost == null ? "text-gray-500" : "text-gray-700"}`}>{l.reading}</td>
                    <td className="py-1.5 pr-3">{l.cost == null ? <span className="text-xs text-gray-500">Not costed</span> : formatCurrency(l.cost)}</td>
                    <td className={`py-1.5 ${thin ? "font-medium text-red-700" : "text-gray-700"}`}>{formatCurrency(l.price)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {c.quantityMarginOverruled == null && (c.quantityCoverage ?? 1) < 0.999 && (
            <p className="mt-1 text-xs text-gray-500">Lines and parts of lines that weren&apos;t costed are checked at your past jobs&apos; rate for this type of job.</p>
          )}
        </div>
      )}

      {c.parts.length > 0 && (
        <p className="mt-1 max-w-2xl text-xs text-gray-500">
          Expected cost is the job&apos;s expected cost split the way it usually splits on these jobs. Price at target is what
          that part needs to sell for to reach your target.
        </p>
      )}

      {(below || ok) && c.methodNote && (
        <p className="mt-2 max-w-3xl rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">{c.methodNote}</p>
      )}

      {c.parts.length > 0 && (
        <table className="mt-3 w-full max-w-2xl text-left text-sm">
          <thead className="text-xs text-gray-500">
            <tr>
              <th className="py-1 font-medium">Part of the job</th>
              <th className="py-1 font-medium">You&apos;re charging</th>
              <th className="py-1 font-medium">Usual share of the cost</th>
              <th className="py-1 font-medium">Expected cost</th>
              <th className="py-1 font-medium">Price at target</th>
            </tr>
          </thead>
          <tbody>
            {c.parts.map((p) => {
              const short = p.priceAtTarget > p.charged * 1.01;
              return (
                <tr key={p.category} className="border-t border-gray-100">
                  <td className="py-1.5 capitalize">{coreCategoryName(p.category)}</td>
                  <td className="py-1.5">{formatCurrency(p.charged)}</td>
                  <td className="py-1.5">{Math.round(p.costShare * 100)}%</td>
                  <td className="py-1.5">{formatCurrency(p.expectedCost)}</td>
                  <td className={`py-1.5 font-medium ${short ? "text-red-700" : "text-gray-700"}`}>{formatCurrency(p.priceAtTarget)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {(below || ok) && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <ConfidenceBadge confidence={e.typeSource === "suggested" ? "low" : c.confidence} />
          <span className="text-xs text-gray-500">
            {c.confidenceReason} Target {c.targetMarginPct != null ? fmtTarget(c.targetMarginPct) : "not set"}, expected margin{" "}
            {formatPct(c.expectedMarginPct)}.
          </span>
        </div>
      )}

      {e.lines.length > 0 && (
        <details className="mt-3 text-xs text-gray-600">
          <summary className="cursor-pointer font-medium text-brand">Estimate lines ({e.lines.length})</summary>
          <table className="mt-2 w-full max-w-xl text-left">
            <tbody>
              {e.lines.map((l, i) => (
                <tr key={i} className="border-t border-gray-100">
                  <td className="py-1">{l.n ?? "(no product or service)"}</td>
                  <td className="py-1 text-gray-500">{categoryLabel(l.c)}</td>
                  <td className="py-1 text-right">{formatCurrency(l.a)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-gray-500">
            Each line goes to a part of the job by its product or service, the same way costs are sorted. A line in the
            wrong part can be moved in Settings, under Cost categories.
          </p>
        </details>
      )}
    </article>
  );
}

/**
 * The line table's heading when the lines were read but too little of the
 * price could be costed from them, so the check went by past jobs. Says how
 * much could be, and what lets a line be costed.
 */
function unusedReadingsText(lines: { price: number; costedPrice: number }[]): string {
  const price = lines.reduce((t, l) => t + l.price, 0);
  const costed = lines.reduce((t, l) => t + l.costedPrice, 0);
  const lead =
    costed <= 0 || price <= 0
      ? "How each line was read. None of them could be costed line by line"
      : `How each line was read. Only ${formatPct(costed / price, 0)} of the price could be costed line by line`;
  return `${lead}, so the check above goes by your past jobs. A line can be costed when it's priced per hour or per unit rather than as a lump sum and, for a product or service, has a purchase cost set in QuickBooks.`;
}
