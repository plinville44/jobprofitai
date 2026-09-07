import type { ReactNode } from "react";

/**
 * Shared table chrome for the admin views. Nothing clever - it exists so the
 * five admin pages don't each reinvent the same markup, and so every one of
 * them scrolls horizontally on a phone instead of breaking the layout.
 */
export function AdminSection({
  title,
  description,
  children,
  actions,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-200 px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-navy">{title}</h2>
          {description ? <p className="mt-1 text-xs text-gray-500">{description}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function AdminTable({
  headers,
  children,
  empty,
  minWidth = 720,
}: {
  headers: string[];
  children: ReactNode;
  empty?: boolean;
  minWidth?: number;
}) {
  if (empty) {
    return <p className="px-5 py-8 text-center text-sm text-gray-500">Nothing here yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm" style={{ minWidth }}>
        <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
          <tr>
            {headers.map((header) => (
              <th key={header} scope="col" className="whitespace-nowrap px-5 py-2.5 font-medium">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">{children}</tbody>
      </table>
    </div>
  );
}

export function Td({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <td className={`px-5 py-3 align-top text-gray-600 ${className}`}>{children}</td>;
}

export function Pill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad" | "info";
}) {
  const tones = {
    neutral: "bg-gray-100 text-gray-700",
    good: "bg-green-50 text-green-700",
    warn: "bg-amber-50 text-amber-800",
    bad: "bg-red-50 text-red-700",
    info: "bg-blue-50 text-blue-700",
  } as const;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function StatGrid({ stats }: { stats: { label: string; value: string }[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {stats.map((stat) => (
        <div key={stat.label} className="rounded-xl border border-gray-200 bg-white px-4 py-3.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
            {stat.label}
          </div>
          <div className="mt-1 text-xl font-bold text-navy">{stat.value}</div>
        </div>
      ))}
    </div>
  );
}
