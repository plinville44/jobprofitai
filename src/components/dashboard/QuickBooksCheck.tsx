"use client";

import { useState } from "react";

interface Line {
  label: string;
  ours: number;
  quickbooks: number;
  difference: number;
  matches: boolean;
}
interface Result {
  lines: Line[];
  allMatch: boolean;
  notes: string[];
  lastSyncedAt: string | null;
}

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

/**
 * "Check against QuickBooks": this job's numbers beside QuickBooks' own
 * Profit and Loss for the same customer or project. Contractors compare
 * anyway; this makes the comparison one click and explains the expected
 * differences.
 */
export default function QuickBooksCheck({ jobId }: { jobId: string }) {
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/quickbooks-check`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Server returned status ${res.status}.`);
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't reach QuickBooks.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6 rounded-xl border border-gray-200 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-navy">Check against QuickBooks</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Compares this job with QuickBooks&apos; own Profit and Loss for the same customer or project.
          </p>
        </div>
        <button
          onClick={run}
          disabled={busy}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
        >
          {busy ? "Asking QuickBooks…" : result ? "Check again" : "Check now"}
        </button>
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {result && (
        <div className="mt-4">
          <p className={`text-sm font-medium ${result.allMatch ? "text-green-700" : "text-amber-700"}`}>
            {result.allMatch ? "Matches QuickBooks." : "Doesn't match QuickBooks yet. See the notes below."}
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[28rem] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-gray-400">
                  <th className="pb-2 font-medium" />
                  <th className="pb-2 text-right font-medium">JobProfitAI</th>
                  <th className="pb-2 text-right font-medium">QuickBooks</th>
                  <th className="pb-2 text-right font-medium">Difference</th>
                </tr>
              </thead>
              <tbody>
                {result.lines.map((l) => (
                  <tr key={l.label} className="border-t border-gray-100">
                    <td className="py-2 text-gray-700">{l.label}</td>
                    <td className="py-2 text-right tabular-nums">{money(l.ours)}</td>
                    <td className="py-2 text-right tabular-nums">{money(l.quickbooks)}</td>
                    <td className={`py-2 text-right tabular-nums ${l.matches ? "text-green-700" : "text-amber-700"}`}>
                      {l.matches ? "Matches" : money(l.difference)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.notes.length > 0 && (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-gray-600">
              {result.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          {result.lastSyncedAt && (
            <p className="mt-2 text-xs text-gray-400">
              JobProfitAI figures as of the last sync, {new Date(result.lastSyncedAt).toLocaleString()}.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
