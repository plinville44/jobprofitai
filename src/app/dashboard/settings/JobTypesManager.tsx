"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface TypeRow {
  value: string;
  label: string;
  hidden: boolean;
  builtIn: boolean;
  jobs: number;
}

/** Add, rename and hide a company's job types. */
export default function JobTypesManager({ connectionId, types }: { connectionId: string; types: TypeRow[] }) {
  const router = useRouter();
  const [labels, setLabels] = useState<Record<string, string>>(Object.fromEntries(types.map((t) => [t.value, t.label])));
  const [newLabel, setNewLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function send(payload: Record<string, unknown>, done: string): Promise<boolean> {
    setBusy(true);
    setStatus(null);
    let ok = false;
    try {
      const res = await fetch("/api/settings/job-types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId, ...payload }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) setStatus(data?.error ?? "Couldn't save that.");
      else {
        ok = true;
        setStatus(done);
        router.refresh();
      }
    } catch {
      setStatus("Network error. Please try again.");
    }
    setBusy(false);
    return ok;
  }

  const visible = types.filter((t) => !t.hidden);
  const hidden = types.filter((t) => t.hidden);

  const row = (t: TypeRow) => (
    <li key={t.value} className="flex flex-wrap items-center gap-3 py-2">
      <input
        aria-label={`Name for ${t.label}`}
        value={labels[t.value] ?? t.label}
        maxLength={40}
        disabled={busy}
        onChange={(e) => setLabels((l) => ({ ...l, [t.value]: e.target.value }))}
        onBlur={() => {
          const next = (labels[t.value] ?? "").trim();
          if (next && next !== t.label) {
            send({ action: "rename", key: t.value, label: next }, `Renamed to ${next}.`).then((ok) => {
              if (!ok) setLabels((l) => ({ ...l, [t.value]: t.label }));
            });
          } else setLabels((l) => ({ ...l, [t.value]: t.label }));
        }}
        className={`w-56 rounded-lg border border-gray-300 px-2 py-1 text-sm ${t.hidden ? "text-gray-400" : ""}`}
      />
      <span className="w-24 text-xs text-gray-500">
        {t.jobs} {t.jobs === 1 ? "job" : "jobs"}
      </span>
      <span className="w-20 text-xs text-gray-400">{t.builtIn ? "Built in" : "Yours"}</span>
      <button
        type="button"
        disabled={busy}
        onClick={() => send({ action: t.hidden ? "show" : "hide", key: t.value }, t.hidden ? `${t.label} is back in the list.` : `${t.label} is hidden.`)}
        className="text-xs font-medium text-brand hover:underline disabled:opacity-60"
      >
        {t.hidden ? "Show" : "Hide"}
      </button>
    </li>
  );

  return (
    <div>
      <ul className="divide-y divide-gray-100">{visible.map(row)}</ul>
      {hidden.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-medium text-gray-500">Hidden ({hidden.length})</summary>
          <p className="mt-1 text-xs text-gray-500">
            Hidden types aren&apos;t offered for new jobs. Jobs that already have one keep it.
          </p>
          <ul className="divide-y divide-gray-100">{hidden.map(row)}</ul>
        </details>
      )}
      <form
        className="mt-4 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const label = newLabel.trim();
          if (!label) return;
          send({ action: "add", label }, `Added ${label}.`).then((ok) => {
            if (ok) setNewLabel("");
          });
        }}
      >
        <input
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          maxLength={40}
          placeholder="Add a job type, e.g. Kitchen remodel"
          className="w-72 rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
        />
        <button type="submit" disabled={busy || !newLabel.trim()} className="rounded-lg bg-navy px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60">
          Add
        </button>
      </form>
      {status && <p className="mt-2 text-sm text-gray-600">{status}</p>}
    </div>
  );
}
