"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { findColumn, parseCsv, parseMoneyCell, unescapeCell } from "@/lib/csv";

/**
 * Setting estimates for many jobs at once: download a spreadsheet of the
 * open jobs, fill in the blanks, import it back. Plus a one-click fill from
 * the target margin for jobs that have a contract value but no budget.
 */
export default function JobBudgetTools({ connectionId, hasTarget }: { connectionId: string; hasTarget: boolean }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [details, setDetails] = useState<string[]>([]);

  async function importFile(file: File) {
    setBusy("import");
    setMessage(null);
    setDetails([]);
    try {
      const rows = parseCsv(await file.text());
      if (rows.length < 2) {
        setMessage("That file has no rows under the header.");
        return;
      }
      const [header, ...body] = rows;
      const col = {
        job: findColumn(header, ["job", "job name", "project", "name"]),
        estimatedCost: findColumn(header, ["estimated cost", "est cost", "budget", "cost budget", "estimate"]),
        contractValue: findColumn(header, ["contract value", "contract", "contract amount", "price"]),
        jobType: findColumn(header, ["job type", "type", "category"]),
        percentComplete: findColumn(header, ["percent complete", "% complete", "complete", "pct complete"]),
      };
      if (col.job < 0) {
        setMessage('No "Job" column found. Use the template, or name the first column "Job".');
        return;
      }
      const payload = body.map((r) => ({
        job: unescapeCell(r[col.job] ?? ""),
        estimatedCost: col.estimatedCost >= 0 ? parseMoneyCell(r[col.estimatedCost]) : null,
        contractValue: col.contractValue >= 0 ? parseMoneyCell(r[col.contractValue]) : null,
        jobType: col.jobType >= 0 ? r[col.jobType] ?? "" : "",
        percentComplete: col.percentComplete >= 0 ? (r[col.percentComplete] ?? "").replace("%", "").trim() : "",
      }));
      const res = await fetch("/api/jobs/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId, rows: payload }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(data.error ?? "Import failed. Please try again.");
        return;
      }
      setMessage(
        `Updated ${data.updated} ${data.updated === 1 ? "job" : "jobs"}.` +
          (data.unmatchedCount ? ` ${data.unmatchedCount} ${data.unmatchedCount === 1 ? "row didn't" : "rows didn't"} match a job name.` : "")
      );
      setDetails([
        ...(data.unmatched ?? []).map((n: string) => `No job named "${n}"`),
        ...(data.problems ?? []),
      ]);
      router.refresh();
    } catch {
      setMessage("Couldn't read that file. Save it as CSV (comma separated) and try again.");
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function fillFromMargin() {
    if (!confirm("Set an estimated cost on every open job that has a contract value but no estimate, as contract value x (1 - target margin)? These are budgets that would hit your target, not quotes. Existing estimates are left alone.")) return;
    setBusy("fill");
    setMessage(null);
    setDetails([]);
    try {
      const res = await fetch("/api/jobs/fill-estimates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setMessage(data.error ?? "Something went wrong.");
      else {
        setMessage(
          `Set estimates on ${data.updated} ${data.updated === 1 ? "job" : "jobs"}.` +
            (data.skippedNoContract ? ` ${data.skippedNoContract} had no contract value to work from.` : "")
        );
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-6 rounded-xl border border-gray-200 bg-gray-50 p-4">
      <p className="text-sm font-semibold text-navy">Estimates, contract values and job types</p>
      <p className="mt-1 text-xs text-gray-600">
        QuickBooks has no field for a job&apos;s cost budget, so set them here in bulk: download the spreadsheet, fill in
        the blanks, and import it back. Rows are matched by job name. Nothing in QuickBooks changes.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <a
          href={`/api/jobs/template?connectionId=${encodeURIComponent(connectionId)}`}
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-navy hover:bg-gray-100"
        >
          Download open jobs (CSV)
        </a>
        <label className="cursor-pointer rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-navy hover:bg-gray-100">
          {busy === "import" ? "Importing…" : "Import CSV"}
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            disabled={busy != null}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importFile(f);
            }}
          />
        </label>
        <button
          type="button"
          onClick={fillFromMargin}
          disabled={busy != null || !hasTarget}
          title={hasTarget ? undefined : "Set a target margin in Settings first"}
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-navy hover:bg-gray-100 disabled:opacity-50"
        >
          {busy === "fill" ? "Filling…" : "Fill missing estimates from target margin"}
        </button>
      </div>
      {message ? <p className="mt-2 text-sm text-gray-700">{message}</p> : null}
      {details.length > 0 ? (
        <ul className="mt-1 max-h-32 list-inside list-disc overflow-y-auto text-xs text-gray-600">
          {details.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
