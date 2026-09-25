"use client";

import { useEffect, useState } from "react";
import { categoryLabel, formatCurrency } from "@/lib/format";

interface Row {
  sourceName: string;
  category: string;
  amount: number;
  count: number;
  mapped: string | null;
}

/** Re-map a QuickBooks account or item to a different cost category. */
export default function CategoryMappingForm({ connectionId }: { connectionId: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    fetch(`/api/settings/categories?connectionId=${encodeURIComponent(connectionId)}`)
      .then((r) => r.json())
      .then((d) => {
        setRows(d.rows ?? []);
        setCategories(d.categories ?? []);
      })
      .catch(() => setRows([]));
  }, [connectionId]);

  async function save(sourceName: string, category: string) {
    setStatus(`Saving ${sourceName}…`);
    const res = await fetch("/api/settings/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionId, sourceName, category: category === "" ? null : category }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(data.error ?? "Couldn't save.");
      return;
    }
    setRows((prev) =>
      (prev ?? []).map((r) =>
        r.sourceName === sourceName ? { ...r, mapped: category || null, category: category || r.category } : r
      )
    );
    setStatus(
      data.pendingSync
        ? `${sourceName} is back on automatic; it updates at the next sync.`
        : `${sourceName}: ${data.updated} cost ${data.updated === 1 ? "line" : "lines"} moved to ${categoryLabel(category)}.`
    );
  }

  if (rows == null) return <p className="text-sm text-gray-500">Loading accounts…</p>;
  if (rows.length === 0) return <p className="text-sm text-gray-500">No job costs synced yet.</p>;
  const shown = showAll ? rows : rows.slice(0, 15);

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-sm">
          <thead className="text-xs uppercase text-gray-500">
            <tr>
              <th className="py-2 font-medium">QuickBooks account or item</th>
              <th className="py-2 text-right font-medium">Job costs</th>
              <th className="py-2 pl-4 font-medium">Category</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {shown.map((r) => (
              <tr key={r.sourceName}>
                <td className="py-2 text-gray-700">{r.sourceName}</td>
                <td className="py-2 text-right text-gray-600">{formatCurrency(r.amount)}</td>
                <td className="py-2 pl-4">
                  <select
                    value={r.mapped ?? ""}
                    onChange={(e) => save(r.sourceName, e.target.value)}
                    className="rounded-md border border-gray-300 px-2 py-1 text-sm"
                  >
                    <option value="">Automatic ({categoryLabel(r.category)})</option>
                    {categories.map((c) => (
                      <option key={c} value={c}>
                        {categoryLabel(c)}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 15 && !showAll ? (
        <button type="button" onClick={() => setShowAll(true)} className="mt-2 text-sm font-medium text-brand hover:underline">
          Show all {rows.length}
        </button>
      ) : null}
      {status ? <p className="mt-2 text-sm text-gray-600">{status}</p> : null}
    </div>
  );
}
