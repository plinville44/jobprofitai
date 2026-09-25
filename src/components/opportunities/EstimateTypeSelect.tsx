"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Picks the job type an estimate is compared against, when it isn't on a typed job. */
export default function EstimateTypeSelect({
  estimateId,
  value,
  options,
}: {
  estimateId: string;
  value: string | null;
  options: { value: string; label: string }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/estimates/job-type", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estimateId, jobType: next || null }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) setError(data?.error ?? "Couldn't save that.");
      else router.refresh();
    } catch {
      setError("Network error. Please try again.");
    }
    setBusy(false);
  }

  return (
    <span className="inline-flex items-center gap-2">
      <select
        aria-label="Job type for this estimate"
        className="rounded-md border border-gray-300 px-2 py-1 text-sm"
        value={value ?? ""}
        disabled={busy}
        onChange={(e) => change(e.target.value)}
      >
        <option value="">Choose a job type</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </span>
  );
}
