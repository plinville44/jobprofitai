import Link from "next/link";
import { ConfidenceBadge } from "@/components/dashboard/Badges";
import { formatCurrency, formatPct } from "@/lib/format";
import { coreCategoryName, GAIN_KINDS, type FeedItem } from "@/lib/opportunities";
import TrackChangeButton from "./TrackChangeButton";

const KIND_LABEL: Record<FeedItem["kind"], string> = {
  estimate_below_target: "Estimate",
  open_job_forecast: "Open job",
  open_job_over_estimate: "Open job",
  underbilled: "Billing",
  job_type_pricing: "Pricing",
  category_pricing: "Pricing",
  small_jobs: "Pricing",
  customer_pricing: "Customer",
  estimate_overrun: "Estimating",
  strong_job_type: "What's working",
};

/**
 * One opportunity: the money, the evidence, what to do, and how the figure
 * was worked out. Every number on the card comes from the calculation; no
 * part of it is written by AI.
 */
export default function FeedItemCard({
  item,
  jobNames,
  connectionId,
  tracked,
  canTrack,
  compact = false,
}: {
  item: FeedItem;
  jobNames: Record<string, string>;
  connectionId: string;
  /** True when this change is already being tracked. */
  tracked?: boolean;
  canTrack?: boolean;
  compact?: boolean;
}) {
  const cash = item.impactKind === "cash";
  return (
    <article id={item.id} className="rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-brand">{KIND_LABEL[item.kind]}</p>
          <h3 className="mt-1 text-base font-semibold text-navy">
            {item.href ? (
              <Link href={item.href} className="hover:underline">
                {item.title}
              </Link>
            ) : (
              item.title
            )}
          </h3>
        </div>
        {item.impact != null && (
          <div className="text-right">
            <p className={`text-xl font-bold ${cash ? "text-amber-700" : item.section === "working" ? "text-green-700" : "text-red-700"}`}>
              {GAIN_KINDS.has(item.kind) ? "+" : ""}
              {formatCurrency(item.impact)}
            </p>
            <p className="text-xs text-gray-500">{item.impactLabel}</p>
          </div>
        )}
      </div>

      <p className="mt-3 text-sm text-gray-700">{item.finding}</p>
      {item.cause && (
        <p className="mt-2 text-sm text-gray-700">
          <span className="font-medium text-navy">Why: </span>
          {item.cause}
        </p>
      )}
      <p className="mt-2 rounded-lg bg-blue-50/60 px-3 py-2 text-sm text-navy">
        <span className="font-semibold">What to do: </span>
        {item.action}
      </p>

      {!compact && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <ConfidenceBadge confidence={item.confidence} />
          <span className="text-xs text-gray-500">{item.confidenceReason}</span>
        </div>
      )}

      {!compact && (item.breakdown || item.method || item.jobIds.length > 0) && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-xs font-medium text-brand">How we worked this out</summary>
          <div className="mt-2 space-y-3 text-xs text-gray-600">
            <p>{item.method}</p>
            {item.breakdown && (
              <table className="w-full max-w-md text-left">
                <thead className="text-gray-400">
                  <tr>
                    <th className="py-1 font-medium">Part of the job</th>
                    <th className="py-1 font-medium">Customers paid</th>
                    <th className="py-1 font-medium">It cost</th>
                    <th className="py-1 font-medium">Margin</th>
                  </tr>
                </thead>
                <tbody>
                  {item.breakdown.map((b) => (
                    <tr key={b.category} className="border-t border-gray-100">
                      <td className="py-1 capitalize">{coreCategoryName(b.category)}</td>
                      <td className="py-1">{formatCurrency(b.charged)}</td>
                      <td className="py-1">{formatCurrency(b.cost)}</td>
                      <td className={`py-1 font-medium ${b.marginPct < 0.1 ? "text-red-700" : "text-gray-700"}`}>{formatPct(b.marginPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {item.jobIds.length > 0 && (
              <p>
                Jobs:{" "}
                {item.jobIds.slice(0, 20).map((id, i) => (
                  <span key={id}>
                    {i > 0 && ", "}
                    <Link href={`/dashboard/jobs/${id}`} className="text-brand hover:underline">
                      {jobNames[id] ?? "Job"}
                    </Link>
                  </span>
                ))}
                {item.jobIds.length > 20 ? `, and ${item.jobIds.length - 20} more` : ""}
              </p>
            )}
          </div>
        </details>
      )}

      {!compact && item.trackable && canTrack && (
        <div className="mt-4 border-t border-gray-100 pt-3">
          {tracked ? (
            <p className="text-xs text-green-700">
              You&apos;re tracking this change. The result shows under Changes you&apos;re tracking.
            </p>
          ) : (
            <TrackChangeButton connectionId={connectionId} itemId={item.id} />
          )}
        </div>
      )}
    </article>
  );
}
