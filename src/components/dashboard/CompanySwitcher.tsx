"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** The company switcher in the dashboard header, for accounts with more than one QuickBooks company. */
export default function CompanySwitcher({
  companies,
  activeId,
}: {
  companies: { id: string; name: string }[];
  activeId: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState(activeId);
  const [busy, setBusy] = useState(false);

  async function choose(id: string) {
    setValue(id);
    setBusy(true);
    try {
      await fetch("/api/company/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: id }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only">Company</span>
      <select
        value={value}
        disabled={busy}
        onChange={(e) => choose(e.target.value)}
        className="max-w-[16rem] rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm font-medium text-navy"
      >
        {companies.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}
