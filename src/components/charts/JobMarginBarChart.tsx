"use client";

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, Cell, ResponsiveContainer } from "recharts";

export interface JobMarginBarDatum {
  jobName: string;
  marginPct: number; // 0-100
}

/**
 * Chart 1: Job Margin by Job. Horizontal bar, sorted worst-to-best, target
 * margin drawn as a reference line. Bar color reflects status (good/warning/
 * critical vs. target) - a status encoding, not a categorical one, so it uses
 * the fixed status palette rather than the categorical series colors.
 */
export default function JobMarginBarChart({
  data,
  targetMarginPct,
}: {
  data: JobMarginBarDatum[];
  targetMarginPct: number | null;
}) {
  const sorted = [...data].sort((a, b) => a.marginPct - b.marginPct);
  const barColor = (marginPct: number) => {
    if (targetMarginPct == null) return "#2a78d6"; // no target set - neutral chart-1 blue
    const gap = targetMarginPct - marginPct;
    if (gap <= 0) return "#0ca30c"; // at/above target - good
    if (gap <= 5) return "#fab219"; // within 5 points - warning
    return "#d03b3b"; // more than 5 points below - critical
  };

  if (sorted.length === 0) {
    return <p className="text-sm text-gray-500">No jobs with a computable margin yet.</p>;
  }

  return (
    <div>
      <ResponsiveContainer width="100%" height={Math.max(sorted.length * 32, 120)}>
        <BarChart data={sorted} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 8 }}>
          <CartesianGrid stroke="#e1e0d9" horizontal={false} />
          <XAxis type="number" tickFormatter={(v) => `${v}%`} stroke="#898781" fontSize={12} />
          <YAxis type="category" dataKey="jobName" width={140} stroke="#898781" fontSize={12} />
          <Tooltip formatter={(value: number) => [`${value.toFixed(1)}%`, "Margin"]} />
          {targetMarginPct != null && (
            <ReferenceLine
              x={targetMarginPct}
              stroke="#0b0b0b"
              strokeDasharray="4 4"
              label={{ value: `Target ${targetMarginPct}%`, position: "top", fontSize: 12, fill: "#52514e" }}
            />
          )}
          <Bar dataKey="marginPct" radius={[0, 4, 4, 0]} barSize={16}>
            {sorted.map((d, i) => (
              <Cell key={i} fill={barColor(d.marginPct)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <div className="mt-2 flex flex-wrap gap-4 text-xs text-gray-500">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "#0ca30c" }} /> At/above target
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "#fab219" }} /> Within 5 points
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "#d03b3b" }} /> More than 5 points below
        </span>
      </div>
    </div>
  );
}
