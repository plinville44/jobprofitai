"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Not set" },
  { value: "roofing", label: "Roofing" },
  { value: "remodel", label: "Remodel" },
  { value: "new_construction", label: "New Construction" },
  { value: "painting", label: "Painting" },
  { value: "plumbing", label: "Plumbing" },
  { value: "electrical", label: "Electrical" },
  { value: "hvac", label: "HVAC" },
  { value: "general", label: "General Contracting" },
  { value: "other", label: "Other" },
];

export default function JobEditForm({
  jobId,
  initialCategory,
  initialEstimatedCost,
}: {
  jobId: string;
  initialCategory: string | null;
  initialEstimatedCost: number | null;
}) {
  const router = useRouter();
  const [category, setCategory] = useState(initialCategory ?? "");
  const [estimatedCost, setEstimatedCost] = useState(
    initialEstimatedCost != null ? String(initialEstimatedCost) : ""
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

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
        QuickBooks doesn&apos;t expose a job type or an internal cost budget, so these two fields are set here
        instead of synced. Job type powers cross-job benchmarking; Estimated Cost powers budget variance and
        Forecast-at-Completion.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-4">
        <label className="flex flex-col text-sm">
          <span className="text-gray-600">Job type</span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="mt-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          >
            {CATEGORY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
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
