"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface Row {
  jobId: string;
  jobName: string;
  customerName: string | null;
  status: string;
  suggested: string | null;
  source: "name" | "estimate" | "ai" | null;
  reason: string | null;
  aiUnsure?: boolean;
}

/**
 * Jobs without a type, with a suggested type for each where one can be
 * found. Nothing is applied until the contractor ticks it and accepts.
 */
export default function JobTypeSuggestions({
  connectionId,
  rows,
  untyped,
  withoutSuggestion,
  types,
}: {
  connectionId: string;
  rows: Row[];
  untyped: number;
  withoutSuggestion: number;
  types: { value: string; label: string }[];
}) {
  const router = useRouter();
  const initialChoice = () => Object.fromEntries(rows.map((r) => [r.jobId, r.suggested ?? ""]));
  const initialTicked = () => new Set(rows.filter((r) => r.suggested).map((r) => r.jobId));
  const [choice, setChoice] = useState<Record<string, string>>(initialChoice);
  const [ticked, setTicked] = useState<Set<string>>(initialTicked);
  /** Rows the contractor changed by hand; new suggestions never overwrite them. */
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // New suggestions arrive after a refresh. Merge them in, keeping any
  // choice made by hand and the message saying what just happened.
  const signature = rows.map((r) => `${r.jobId}:${r.suggested ?? ""}`).join("|");
  useEffect(() => {
    const fresh = initialChoice();
    setChoice((prev) => {
      const next: Record<string, string> = { ...fresh };
      for (const id of touched) if (id in fresh) next[id] = prev[id] ?? fresh[id];
      return next;
    });
    setTicked((prev) => {
      const next = initialTicked();
      for (const id of touched) {
        if (!rows.some((r) => r.jobId === id)) continue;
        if (prev.has(id)) next.add(id);
        else next.delete(id);
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  if (untyped === 0 && !message) return null;

  async function post(url: string, body: unknown) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, data };
  }

  async function accept() {
    const assignments = rows.filter((r) => ticked.has(r.jobId) && choice[r.jobId]).map((r) => ({ jobId: r.jobId, category: choice[r.jobId] }));
    if (assignments.length === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      let updated = 0;
      for (let i = 0; i < assignments.length; i += 500) {
        const { ok, data } = await post("/api/jobs/accept-types", { connectionId, assignments: assignments.slice(i, i + 500) });
        if (!ok) {
          setMessage(`${updated ? `Set the type on ${updated} jobs, then: ` : ""}${data?.error ?? "Couldn't save that."}`);
          setBusy(false);
          router.refresh();
          return;
        }
        updated += data.updated;
      }
      setMessage(`Set the type on ${updated} ${updated === 1 ? "job" : "jobs"}.`);
      router.refresh();
    } catch {
      setMessage("Network error. Please try again.");
    }
    setBusy(false);
  }

  async function askAi() {
    setBusy(true);
    setMessage("Asking AI about the jobs whose names we couldn't read...");
    try {
      const { ok, data } = await post("/api/jobs/suggest-types", { connectionId });
      setMessage(ok ? data.message : data?.error ?? "Couldn't get suggestions.");
      if (ok) router.refresh();
    } catch {
      setMessage("Network error. Please try again.");
    }
    setBusy(false);
  }

  const suggestedCount = rows.filter((r) => r.suggested).length;

  return (
    <section id="job-types" className="mt-6 rounded-xl border border-blue-200 bg-blue-50/40 p-5">
      <h2 className="text-sm font-semibold text-navy">
        {untyped === 0 ? "Every job has a type now" : `${untyped} ${untyped === 1 ? "job has" : "jobs have"} no job type`}
      </h2>
      <p className="mt-1 text-sm text-gray-600">
        Job type is how your jobs are compared with each other, and QuickBooks can&apos;t tell us it.
        {suggestedCount > 0
          ? ` We've suggested a type for ${suggestedCount} from their names and estimates. Check them in the list, change any that are wrong, untick any you're unsure of, and accept.`
          : " Set them here or on each job."}{" "}
        <Link href="/dashboard/settings#job-types" className="font-medium text-brand hover:underline">
          Add or rename job types
        </Link>
      </p>

      <div className="mt-4 max-h-[28rem] overflow-auto rounded-lg border border-blue-100 bg-white">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="sticky top-0 bg-white text-xs uppercase text-gray-500">
            <tr>
              <th className="w-8 py-2"></th>
              <th className="py-2 font-medium">Job</th>
              <th className="py-2 font-medium">Job type</th>
              <th className="py-2 font-medium">Why</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-blue-100">
            {rows.map((r) => (
              <tr key={r.jobId}>
                <td className="py-2 pl-3">
                  <input
                    type="checkbox"
                    aria-label={`Accept a type for ${r.jobName}`}
                    checked={ticked.has(r.jobId)}
                    disabled={!choice[r.jobId]}
                    onChange={() => {
                      setTouched((t) => new Set(t).add(r.jobId));
                      setTicked((t) => {
                        const n = new Set(t);
                        if (n.has(r.jobId)) n.delete(r.jobId);
                        else n.add(r.jobId);
                        return n;
                      });
                    }}
                  />
                </td>
                <td className="py-2">
                  <Link href={`/dashboard/jobs/${r.jobId}`} className="font-medium text-navy hover:underline">
                    {r.jobName}
                  </Link>
                  {r.customerName ? <span className="text-xs text-gray-500"> · {r.customerName}</span> : null}
                </td>
                <td className="py-2">
                  <select
                    aria-label={`Job type for ${r.jobName}`}
                    value={choice[r.jobId] ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      setTouched((t) => new Set(t).add(r.jobId));
                      setChoice((c) => ({ ...c, [r.jobId]: v }));
                      setTicked((t) => {
                        const n = new Set(t);
                        if (v) n.add(r.jobId);
                        else n.delete(r.jobId);
                        return n;
                      });
                    }}
                    className="rounded-md border border-gray-300 px-2 py-1 text-sm"
                  >
                    <option value="">Not set</option>
                    {types.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-2 text-xs text-gray-500">{choice[r.jobId] ? (choice[r.jobId] === r.suggested ? r.reason ?? "" : "Your choice") : r.reason ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={accept}
          disabled={busy || ticked.size === 0}
          className="rounded-lg bg-navy px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          Accept {ticked.size} {ticked.size === 1 ? "type" : "types"}
        </button>
        {withoutSuggestion > 0 && (
          <button
            type="button"
            onClick={askAi}
            disabled={busy}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-navy hover:bg-gray-50 disabled:opacity-60"
          >
            Ask AI to suggest the other {withoutSuggestion}
          </button>
        )}
        {message && <span className="text-sm text-gray-600">{message}</span>}
      </div>
      {withoutSuggestion > 0 && (
        <p className="mt-2 text-xs text-gray-500">
          AI reads only the job and customer names. It leaves a job blank when the name doesn&apos;t say what the work is.
        </p>
      )}
    </section>
  );
}
