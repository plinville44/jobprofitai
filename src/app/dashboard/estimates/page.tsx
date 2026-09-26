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
  const { connection } = await getActiveConnection(account.ownerId);
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
            <EstimateCard key={e.id} e={e} options={options} />
          ))}
        </div>
      )}

      <section className="mt-10 rounded-xl border border-gray-200 p-5 text-xs text-gray-600">
        <h2 className="text-sm font-semibold text-navy">How the check works</h2>
        <p className="mt-2">
          We take your finished jobs of the same type from the last two years and work out what they cost for every
          dollar you charged. When your QuickBooks estimates break the price into labor, materials, subcontractors and
          equipment, each part is checked at the rate that part actually ran; otherwise the whole price is checked at
          the jobs&apos; overall rate. The price at target is what the expected cost needs to sell for to hit your target
          margin for that job type.
        </p>
        <p className="mt-2">
          It needs at least three finished jobs of the type with revenue and costs. It says what happened on your past
          jobs; a job that&apos;s genuinely different from them won&apos;t follow it.
        </p>
      </section>
    </main>
  );
}

function EstimateCard({ e, options }: { e: CheckedEstimate; options: { value: string; label: string }[] }) {
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
        {e.typeSource === "job" ? (
          <span>
            {e.typeLabel} <span className="text-xs text-gray-500">(from the job)</span>
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

      {c.parts.length > 0 && (
        <table className="mt-3 w-full max-w-2xl text-left text-sm">
          <thead className="text-xs text-gray-500">
            <tr>
              <th className="py-1 font-medium">Part of the job</th>
              <th className="py-1 font-medium">You&apos;re charging</th>
              <th className="py-1 font-medium">Past jobs spent per $1 charged</th>
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
                  <td className="py-1.5">${p.costRatio.toFixed(2)}</td>
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
