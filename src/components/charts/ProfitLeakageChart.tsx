"use client";

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell, ResponsiveContainer } from "recharts";

export interface ProfitLeakageStep {
  label: string;
  value: number;
  isTotal: boolean;
}

/**
 * Chart 4: Profit Leakage / Variance bridge for one job - the movement from
 * expected profit to actual/forecast profit. Built as a "floating bar"
 * waterfall: total steps sit on the axis, delta steps float between the
 * running total before and after them. Every step here is a real computed
 * delta (see computeProfitLeakage in src/lib/profitability.ts) - nothing
 * fabricated to fill in a category breakdown the data doesn't support.
 */
export default function ProfitLeakageChart({ steps }: { steps: ProfitLeakageStep[] }) {
  if (steps.length === 0) {
    return <p className="text-sm text-gray-500">Not enough estimate and actual data to show profit movement for this job.</p>;
  }

  let running = 0;
  const rows = steps.map((step) => {
    if (step.isTotal) {
      running = step.value;
      return { label: step.label, base: 0, visible: step.value, display: step.value, color: "#2a78d6", isTotal: true };
    }
    const start = running;
    running = running + step.value;
    const base = Math.min(start, running);
    const visible = Math.abs(step.value);
    return {
      label: step.label,
      base,
      visible,
      display: step.value,
      color: step.value >= 0 ? "#0ca30c" : "#d03b3b",
      isTotal: false,
    };
  });

  return (
    <ResponsiveContainer width="100%" height={Math.max(rows.length * 44, 160)}>
      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 32, bottom: 4, left: 8 }} stackOffset="none">
        <CartesianGrid stroke="#e1e0d9" horizontal={false} />
        <XAxis type="number" tickFormatter={(v) => `$${Math.round(v).toLocaleString()}`} stroke="#898781" fontSize={12} />
        <YAxis type="category" dataKey="label" width={140} stroke="#898781" fontSize={12} />
        <Tooltip
          formatter={(_value: any, _name: any, props: any) => [`$${Math.round(props.payload.display).toLocaleString()}`, "Amount"]}
        />
        <Bar dataKey="base" stackId="a" fill="transparent" isAnimationActive={false} />
        <Bar dataKey="visible" stackId="a" radius={[0, 4, 4, 0]} barSize={18}>
          {rows.map((r, i) => (
            <Cell key={i} fill={r.color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
