"use client";

import { useRouter } from "next/navigation";

export default function SortSelect({
  sort,
  status,
  options,
}: {
  sort: string;
  status: string;
  options: { key: string; label: string }[];
}) {
  const router = useRouter();

  return (
    <select
      defaultValue={sort}
      onChange={(e) => {
        const params = new URLSearchParams({ sort: e.target.value, status });
        router.push(`/dashboard/jobs?${params.toString()}`);
      }}
      className="rounded-md border border-gray-200 px-2 py-1.5 text-xs"
    >
      {options.map((o) => (
        <option key={o.key} value={o.key}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
