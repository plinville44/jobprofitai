"use client";

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";

export interface EstimateVsActualDatum {
  category: string;
  estimated: number | null; // null = no estimate exists at this level (e.g. QuickBooks doesn't expose per-category budgets - see plan §6) - renders as Actual-only, never as a fabricated $0 estimate
  actual: number;
}

const CATEGORY_LABELS: Record<string, string> = {
  labor: "Labor",
  materials: "Materials",
  subcontractor: "Subcontractors",
  equipment: "Equipment",
  overhead: "Overhead",
  other: "Other",
};

/**
 * Chart 2: Estimated vs. Actual Cost by Category. Only categories with real
 * data appear (callers filter before passing in) - never a zero-value
 * "Equipment: $0" bar for a contractor who never uses equipment costs.
 *
 * QuickBooks only ever gives us ONE total cost estimate per job, never a
 * per-category budget (see plan §6) - so when every row's `estimated` is
 * null (the company-wide dashboard view, broken out by category), this
 * renders as an Actual-only chart rather than fabricating a category split
 * of a number that was never broken down that way. When a row does carry a
 * real `estimated` value (the Job Detail page's single "Total" row, where
 * the job's one real estimate is being compared to its one actual total),
 * the grouped Estimated/Actual comparison renders normally.
 */
export default function EstimateVsActualChart({ data }: { data: EstimateVsActualDatum[] }) {
  if (data.length === 0) {
    return <p className="text-sm text-gray-500">No categorized cost data yet.</p>;
  }
  const labeled = data.map((d) => ({ ...d, label: CATEGORY_LABELS[d.category] ?? d.category }));
  const hasAnyEstimate = labeled.some((d) => d.estimated != null);

  return (
    <ResponsiveContainer width="100%" height={Math.max(labeled.length * 48, 160)}>
      <BarChart data={labeled} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 8 }}>
        <CartesianGrid stroke="#e1e0d9" horizontal={false} />
        <XAxis type="number" tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} stroke="#898781" fontSize={12} />
        <YAxis type="category" dataKey="label" width={110} stroke="#898781" fontSize={12} />
        <Tooltip formatter={(value: any) => `$${Number(value).toLocaleString()}`} />
        {hasAnyEstimate && <Legend wrapperStyle={{ fontSize: 12 }} />}
        {hasAnyEstimate && (
          <Bar dataKey="estimated" name="Estimated" fill="#2a78d6" radius={[0, 4, 4, 0]} barSize={14} />
        )}
        <Bar dataKey="actual" name="Actual" fill={hasAnyEstimate ? "#eb6834" : "#2a78d6"} radius={[0, 4, 4, 0]} barSize={14} />
      </BarChart>
    </ResponsiveContainer>
  );
}
