import Link from "next/link";
import { ConfidenceBadge } from "@/components/dashboard/Badges";
import { formatCurrency, formatDate, formatPct } from "@/lib/format";
import { coreCategoryName } from "@/lib/opportunities";
import type { TrackedActionView } from "@/lib/opportunityData";
import StopTrackingButton from "./StopTrackingButton";

/** Pricing changes the contractor said they're making, with before and after. */
export default function TrackedChanges({ actions, jobNames }: { actions: TrackedActionView[]; jobNames: Record<string, string> }) {
  if (actions.length === 0) {
    return (
      <p className="mt-3 text-sm text-gray-500">
        Nothing tracked yet. When you act on a pricing opportunity, press &ldquo;I&apos;m making this change&rdquo; on it.
        We&apos;ll record where you started and show the before and after as jobs priced from that day finish.
      </p>
    );
  }
  return (
    <div className="mt-4 space-y-4">
      {actions.map((a) => {
        const o = a.outcome;
        const measured = o.status === "measured";
        const better = measured && (o.extraProfit ?? 0) > 0;
        return (
          <article key={a.id} className="rounded-xl border border-gray-200 bg-white p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  {a.subjectLabel}
                  {a.costCategory ? `, ${coreCategoryName(a.costCategory)}` : ""} · since {formatDate(a.startedAt)}
                  {a.stoppedAt ? ` · stopped ${formatDate(a.stoppedAt)}` : ""}
                </p>
                <h3 className="mt-1 text-base font-semibold text-navy">{a.action}</h3>
              </div>
              {measured && o.extraProfit != null && (
                <div className="text-right">
                  <p className={`text-xl font-bold ${better ? "text-green-700" : "text-gray-600"}`}>
                    {better ? "+" : ""}
                    {formatCurrency(o.extraProfit)}
                  </p>
                  <p className="text-xs text-gray-500">gross profit vs. before</p>
                </div>
              )}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div>
                <p className="text-xs text-gray-500">Before</p>
                <p className="font-semibold text-navy">{formatPct(a.baselineMarginPct)}</p>
                <p className="text-xs text-gray-400">{a.baselineJobs} finished jobs</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Since</p>
                <p className="font-semibold text-navy">{measured ? formatPct(o.afterMarginPct) : "Waiting"}</p>
                <p className="text-xs text-gray-400">{o.afterJobs} finished jobs</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Target</p>
                <p className="font-semibold text-navy">{a.targetMarginPct != null ? `${a.targetMarginPct}%` : "Not set"}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">In progress</p>
                <p className="font-semibold text-navy">{o.inProgress}</p>
                <p className="text-xs text-gray-400">set up since</p>
              </div>
            </div>
            <p className="mt-3 text-sm text-gray-700">{o.message}</p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              {measured && <ConfidenceBadge confidence={o.confidence} />}
              {o.jobIds.length > 0 && (
                <span className="text-xs text-gray-500">
                  Jobs:{" "}
                  {o.jobIds.slice(0, 10).map((id, i) => (
                    <span key={id}>
                      {i > 0 && ", "}
                      <Link href={`/dashboard/jobs/${id}`} className="text-brand hover:underline">
                        {jobNames[id] ?? "Job"}
                      </Link>
                    </span>
                  ))}
                </span>
              )}
            </div>
            <div className="mt-3 border-t border-gray-100 pt-3">
              <StopTrackingButton actionId={a.id} stopped={a.stoppedAt != null} />
            </div>
          </article>
        );
      })}
      <p className="text-xs text-gray-400">
        &ldquo;Since&rdquo; is jobs created in QuickBooks after the change and marked completed, the ones priced under it.
        Before and after compare margins on different jobs, so a few jobs can swing the result either way.
      </p>
    </div>
  );
}
