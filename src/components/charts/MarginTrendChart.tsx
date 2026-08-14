"use client";

import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer } from "recharts";

export interface MarginTrendDatum {
  period: string;
  marginPct: number | null; // 0-100, null = no completed-job revenue that period (gap in the line, not zero)
}

/**
 * Chart 3: Margin Trend across completed jobs. Single series - per the
 * accessibility rule, one series needs no legend box (the chart title names
 * it). A null point renders as a gap rather than a misleading dip to 0%.
 */
export default function MarginTrendChart({
  data,
  targetMarginPct,
}: {
  data: MarginTrendDatum[];
  targetMarginPct: number | null;
}) {
  if (data.length === 0) {
    return <p className="text-sm text-gray-500">Not enough completed-job history yet to show a trend.</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
        <CartesianGrid stroke="#e1e0d9" vertical={false} />
        <XAxis dataKey="period" stroke="#898781" fontSize={12} />
        <YAxis tickFormatter={(v) => `${v}%`} stroke="#898781" fontSize={12} />
        <Tooltip formatter={(value: number | null) => (value == null ? ["No data", "Margin"] : [`${value.toFixed(1)}%`, "Margin"])} />
        {targetMarginPct != null && (
          <ReferenceLine
            y={targetMarginPct}
            stroke="#0b0b0b"
            strokeDasharray="4 4"
            label={{ value: `Target ${targetMarginPct}%`, position: "insideTopLeft", fontSize: 12, fill: "#52514e" }}
          />
        )}
        <Line
          type="monotone"
          dataKey="marginPct"
          stroke="#2a78d6"
          strokeWidth={2}
          dot={{ r: 4 }}
          connectNulls={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
