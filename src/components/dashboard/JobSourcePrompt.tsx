"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Asked once, of companies that use QuickBooks Classes: are your jobs your
 * classes, or your customers? Classes are as often divisions or phases as
 * jobs, so this is never switched on without asking.
 */
export default function JobSourcePrompt({ connectionId, current }: { connectionId: string; current: "projects" | "customers" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function answer(jobSource: "classes" | "projects" | "customers") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/job-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId, jobSource }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) setError(data?.error ?? "Couldn't save that. Please try again.");
      else router.refresh();
    } catch {
      setError("Network error. Please try again.");
    }
    setBusy(false);
  }

  return (
    <section className="mt-6 rounded-xl border border-brand/30 bg-brand-light/40 p-5">
      <h2 className="text-base font-semibold text-navy">Is each job a Class in your QuickBooks?</h2>
      <p className="mt-1 max-w-3xl text-sm text-gray-700">
        Your company uses QuickBooks Classes. Some contractors make a class for each job and pick it on every bill,
        expense, time entry and invoice; others use classes for divisions or phases and keep jobs as customers. Right
        now your jobs are read from {current === "customers" ? "your customers (one customer per job)" : "your Projects and sub-customers"}.
      </p>
      <div className="mt-3 flex flex-wrap gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => answer("classes")}
          className="rounded-lg bg-navy px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
        >
          Yes, each job is a class
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => answer(current)}
          className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-navy hover:bg-gray-50 disabled:opacity-60"
        >
          No, keep jobs as they are
        </button>
      </div>
      <p className="mt-2 text-xs text-gray-500">
        Choosing classes re-reads your jobs at the next sync. You can change this any time in Settings.
      </p>
      {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
    </section>
  );
}
