"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { NO_VALUE, formatCurrency, formatPct, formatDate } from "@/lib/format";
import { JOB_TYPE_OPTIONS } from "@/lib/jobTypes";
import { DataQualityBadge } from "@/components/dashboard/Badges";

export interface JobRow {
  jobId: string;
  jobName: string;
  customerName: string | null;
  status: string;
  revenue: number;
  estimatedCost: number | null;
  costs: number;
  grossProfit: number | null;
  grossMarginPct: number | null;
  profitabilityAvailable: boolean;
  targetMarginPct: number | null;
  varianceVsEstimate: number | null;
  dataConfidence: "high" | "medium" | "low" | "insufficient_data";
  lastFinancialActivity: Date | null;
}

/**
 * The job table, with selection and bulk edit.
 *
 * Marking jobs finished is unavoidably manual - QuickBooks exposes no project
 * status through its API - so this is the screen where that chore has to not
 * feel like one. A contractor catching up after a busy month selects the
 * finished jobs and marks them all at once, rather than opening a dozen
 * pages. Job type is offered in the same bar because it is the other field
 * people fill in a batch, usually right after their first sync.
 */
export default function JobsTable({ jobs }: { jobs: JobRow[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const allSelected = jobs.length > 0 && selected.size === jobs.length;
  const someSelected = selected.size > 0 && !allSelected;

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(jobs.map((j) => j.jobId)));
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function apply(change: Record<string, string | null>, describe: (n: number) => string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/jobs/bulk", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobIds: [...selected], ...change }),
      });
      let data: { updated?: number; requested?: number; error?: string } | null = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (res.ok && data?.updated != null) {
        // Says what actually changed, not what was asked for. updateMany
        // filters by ownership, so a mismatch here is worth showing rather
        // than papering over.
        setMessage(
          data.updated === data.requested
            ? describe(data.updated)
            : `${describe(data.updated)} ${(data.requested ?? 0) - data.updated} couldn't be updated.`
        );
        setSelected(new Set());
        router.refresh();
      } else {
        setMessage(`Failed: ${data?.error ?? `Server returned status ${res.status}.`}`);
      }
    } catch (err) {
      setMessage(`Failed: ${err instanceof Error ? err.message : "Network error - please try again."}`);
    }
    setBusy(false);
  }

  const n = selected.size;
  const plural = n === 1 ? "job" : "jobs";

  return (
    <>
      {/* The bar only exists once something is selected, so the default view
          of this page is unchanged for someone who never bulk-edits. */}
      {n > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-brand-light bg-blue-50/60 px-4 py-3">
          <span className="text-sm font-medium text-navy">
            {n} {plural} selected
          </span>

          <button
            type="button"
            disabled={busy}
            onClick={() => apply({ statusOverride: "closed" }, (c) => `Marked ${c} ${c === 1 ? "job" : "jobs"} completed.`)}
            className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            Mark completed
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={() => apply({ statusOverride: "open" }, (c) => `Marked ${c} ${c === 1 ? "job" : "jobs"} active.`)}
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-navy hover:bg-gray-50 disabled:opacity-60"
          >
            Mark active
          </button>

          <label className="flex items-center gap-2 text-sm text-gray-600">
            Set job type
            <select
              disabled={busy}
              defaultValue=""
              onChange={(e) => {
                const value = e.target.value;
                e.target.value = "";
                if (!value) return;
                const label = JOB_TYPE_OPTIONS.find((o) => o.value === value)?.label ?? value;
                apply({ category: value }, (c) => `Set ${c} ${c === 1 ? "job" : "jobs"} to ${label}.`);
              }}
              className="rounded-md border border-gray-300 px-2 py-1.5 text-sm"
            >
              <option value="">Choose...</option>
              {JOB_TYPE_OPTIONS.filter((o) => o.value).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="text-sm text-gray-500 underline underline-offset-2 hover:text-navy"
          >
            Clear
          </button>

          {busy && <span className="text-sm text-gray-500">Saving...</span>}
        </div>
      )}

      {message && !busy && <p className="mt-3 text-sm text-gray-600">{message}</p>}

      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200">
        <table className="w-full min-w-[960px] text-left text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-500">
            <tr>
              <th className="w-10 px-4 py-2">
                <input
                  id="jobs-select-all"
                  type="checkbox"
                  aria-label="Select all jobs"
                  checked={allSelected}
                  ref={(el) => {
                    // Indeterminate is a property, not an attribute, so it
                    // cannot be set in JSX. Without it, a partial selection
                    // renders as an empty box and "select all" looks broken.
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={toggleAll}
                  className="h-4 w-4 cursor-pointer rounded border-gray-300"
                />
              </th>
              <th className="px-4 py-2 font-medium">Job</th>
              <th className="px-4 py-2 font-medium">Customer</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Revenue</th>
              <th className="px-4 py-2 font-medium">Est. Cost</th>
              <th className="px-4 py-2 font-medium">Actual Cost</th>
              <th className="px-4 py-2 font-medium">Gross Profit</th>
              <th className="px-4 py-2 font-medium">Gross Margin</th>
              <th className="px-4 py-2 font-medium">Target</th>
              <th className="px-4 py-2 font-medium">Variance</th>
              <th className="px-4 py-2 font-medium">Data</th>
              <th className="px-4 py-2 font-medium">Last Activity</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {jobs.map((j) => {
              const isSelected = selected.has(j.jobId);
              return (
                <tr key={j.jobId} className={isSelected ? "bg-blue-50/50" : "hover:bg-gray-50"}>
                  <td className="px-4 py-3">
                    <input
                      id={`job-select-${j.jobId}`}
                      type="checkbox"
                      aria-label={`Select ${j.jobName}`}
                      checked={isSelected}
                      onChange={() => toggleOne(j.jobId)}
                      className="h-4 w-4 cursor-pointer rounded border-gray-300"
                    />
                  </td>
                  <td className="px-4 py-3 font-medium text-navy">
                    <Link href={`/dashboard/jobs/${j.jobId}`} className="hover:underline">
                      {j.jobName}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{j.customerName ?? NO_VALUE}</td>
                  <td className="px-4 py-3 text-gray-600">{j.status === "open" ? "Active" : "Completed"}</td>
                  <td className="px-4 py-3 text-gray-600">{formatCurrency(j.revenue)}</td>
                  <td className="px-4 py-3 text-gray-600">{formatCurrency(j.estimatedCost)}</td>
                  <td className="px-4 py-3 text-gray-600">{formatCurrency(j.costs)}</td>
                  <td className="px-4 py-3 text-gray-600">
                    {j.profitabilityAvailable ? formatCurrency(j.grossProfit) : NO_VALUE}
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {j.profitabilityAvailable ? formatPct(j.grossMarginPct) : "Unavailable"}
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {j.targetMarginPct != null ? `${j.targetMarginPct}%` : NO_VALUE}
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {j.varianceVsEstimate != null ? formatCurrency(j.varianceVsEstimate) : NO_VALUE}
                  </td>
                  <td className="px-4 py-3">
                    <DataQualityBadge confidence={j.dataConfidence} />
                  </td>
                  <td className="px-4 py-3 text-gray-500">{formatDate(j.lastFinancialActivity)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
