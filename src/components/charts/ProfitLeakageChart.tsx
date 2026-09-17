"use client";

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell, ResponsiveContainer } from "recharts";

export interface ProfitLeakageStep {
  label: string;
  value: number;
  isTotal: boolean;
}

interface LeakageRow {
  label: string;
  base: number;
  visible: number;
  display: number;
  color: string;
  isTotal: boolean;
}

/**
 * Turns the leakage steps into floating-bar rows, carrying a running total.
 *
 * A module-level function rather than inline in the component body on
 * purpose. The running total has to be mutated as it walks the steps, and
 * mutating a variable declared in a component during render is the thing
 * react-hooks/immutability exists to catch: it blocks the React Compiler
 * from memoizing the component, and it is a genuine footgun the moment
 * anything about the render becomes concurrent. Out here it is just a pure
 * function of its argument.
 */
function buildRows(steps: ProfitLeakageStep[]): LeakageRow[] {
  const rows: LeakageRow[] = [];
  let running = 0;

  for (const step of steps) {
    if (step.isTotal) {
      running = step.value;
      rows.push({
        label: step.label,
        base: 0,
        visible: step.value,
        display: step.value,
        color: "#2a78d6",
        isTotal: true,
      });
      continue;
    }

    const start = running;
    running = running + step.value;
    rows.push({
      label: step.label,
      base: Math.min(start, running),
      visible: Math.abs(step.value),
      display: step.value,
      color: step.value >= 0 ? "#0ca30c" : "#d03b3b",
      isTotal: false,
    });
  }

  return rows;
}

/**
 * The waterfall is drawn as two stacked bars: a transparent `base` that
 * positions each floating step, and the `visible` bar on top of it. The
 * default tooltip lists every series in the stack, so it printed the amount
 * twice, both rows labelled "Amount" and both showing the same number - the
 * invisible spacer bar reporting itself. Rendering the row once, with the
 * step's own name, is clearer than the original was even before the repeat.
 */
function LeakageTooltip({ active, payload }: { active?: boolean; payload?: { payload?: LeakageRow }[] }) {
  const row = active ? payload?.[0]?.payload : null;
  if (!row) return null;
  return (
    <div className="rounded-md border border-gray-200 bg-white px-3 py-2 text-xs shadow-sm">
      <p className="font-medium text-navy">{row.label}</p>
      <p className="mt-0.5 text-gray-600">${Math.round(row.display).toLocaleString()}</p>
    </div>
  );
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

  const rows = buildRows(steps);

  return (
    <ResponsiveContainer width="100%" height={Math.max(rows.length * 44, 160)}>
      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 32, bottom: 4, left: 8 }} stackOffset="none">
        <CartesianGrid stroke="#e1e0d9" horizontal={false} />
        <XAxis type="number" tickFormatter={(v) => `$${Math.round(v).toLocaleString()}`} stroke="#898781" fontSize={12} />
        <YAxis type="category" dataKey="label" width={140} stroke="#898781" fontSize={12} />
        <Tooltip content={<LeakageTooltip />} cursor={{ fill: "#f5f5f3" }} />
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
