"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { JOB_TYPE_OPTIONS, suggestJobType } from "@/lib/jobTypes";


export default function JobEditForm({
  jobId,
  jobName,
  initialCategory,
  initialEstimatedCost,
  initialStatusOverride,
  syncedStatus,
}: {
  jobId: string;
  jobName: string;
  initialCategory: string | null;
  initialEstimatedCost: number | null;
  initialStatusOverride: string | null;
  /** What QuickBooks itself says, shown so "Follow QuickBooks" is not a guess. */
  syncedStatus: string;
}) {
  const router = useRouter();
  const [category, setCategory] = useState(initialCategory ?? "");
  const [estimatedCost, setEstimatedCost] = useState(
    initialEstimatedCost != null ? String(initialEstimatedCost) : ""
  );
  const [statusOverride, setStatusOverride] = useState(initialStatusOverride ?? "");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // Offered, never applied. The suggestion only shows while the field is
  // still unset, and clicking it fills the dropdown without saving, so the
  // customer confirms before a guess of ours starts feeding benchmarking.
  const suggestion = category === "" ? suggestJobType(jobName) : null;

  async function save() {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: category === "" ? null : category,
          estimatedCost: estimatedCost === "" ? null : Number(estimatedCost),
          statusOverride: statusOverride === "" ? null : statusOverride,
        }),
      });
      let data: any = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (res.ok) {
        setStatus("Saved.");
        router.refresh();
      } else {
        setStatus(`Failed: ${data?.error ?? `Server returned status ${res.status}.`}`);
      }
    } catch (err) {
      setStatus(`Failed: ${err instanceof Error ? err.message : "Network error - please try again."}`);
    }
    setBusy(false);
  }

  return (
    <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Job Details (manual)</p>
      <p className="mt-1 text-xs text-gray-500">
        QuickBooks doesn&apos;t expose a job type, an internal cost budget, or a project&apos;s status, so these
        are set here instead of synced. Job type powers cross-job benchmarking; Estimated Cost powers budget
        variance and Forecast-at-Completion; Job status decides whether a job counts as finished work, which is
        what Profit Intelligence compares.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-4">
        <label className="flex flex-col text-sm">
          <span className="text-gray-600">Job type</span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="mt-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          >
            {JOB_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          {suggestion && (
            <button
              type="button"
              onClick={() => setCategory(suggestion.value)}
              className="mt-1 self-start text-xs font-medium text-brand hover:underline"
            >
              Use {suggestion.label}, from &ldquo;{suggestion.matchedOn}&rdquo; in the name
            </button>
          )}
        </label>
        <label className="flex flex-col text-sm">
          <span className="text-gray-600">Job status</span>
          <select
            value={statusOverride}
            onChange={(e) => setStatusOverride(e.target.value)}
            className="mt-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          >
            <option value="">
              Follow QuickBooks ({syncedStatus === "closed" ? "completed" : "active"})
            </option>
            <option value="closed">Completed</option>
            <option value="open">Still active</option>
          </select>
          <span className="mt-1 text-xs text-gray-500">
            Marking a project complete in QuickBooks doesn&apos;t reach us.
          </span>
        </label>
        <label className="flex flex-col text-sm">
          <span className="text-gray-600">Estimated cost ($)</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={estimatedCost}
            onChange={(e) => setEstimatedCost(e.target.value)}
            placeholder="e.g. 12000"
            className="mt-1 w-36 rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          />
        </label>
        <button
          onClick={save}
          disabled={busy}
          className="rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-white hover:bg-brand/90 disabled:opacity-60"
        >
          {busy ? "Saving..." : "Save"}
        </button>
        {status && <span className="text-sm text-gray-500">{status}</span>}
      </div>
    </div>
  );
}
