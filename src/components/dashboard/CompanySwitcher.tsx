"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { COMPANY_FILTER_THRESHOLD, filterCompanies, sortCompaniesByName } from "@/lib/companyPicker";

/** The company switcher in the dashboard header, for accounts with more than one QuickBooks company. */
export default function CompanySwitcher({
  companies,
  activeId,
}: {
  companies: { id: string; name: string }[];
  activeId: string;
}) {
  const router = useRouter();
  const sorted = useMemo(() => sortCompaniesByName(companies), [companies]);
  const [value, setValue] = useState(activeId);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);

  // The company on screen can change without this menu being used: "Open"
  // on the portfolio, "Switch to this company" in Settings, or a link from
  // an email. Follow it, or the header names one company while the page
  // shows another.
  useEffect(() => {
    setValue(activeId);
    setFilter("");
  }, [activeId]);

  async function choose(id: string) {
    setValue(id);
    setBusy(true);
    try {
      const res = await fetch("/api/company/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: id }),
      });
      // Not switched (the company was disconnected in another tab, say):
      // show the one still on screen.
      if (!res.ok) setValue(activeId);
      router.refresh();
    } catch {
      setValue(activeId);
    } finally {
      setBusy(false);
    }
  }

  const shown = filterCompanies(sorted, filter, value);

  return (
    <div className="flex items-center gap-2 text-sm">
      {sorted.length > COMPANY_FILTER_THRESHOLD ? (
        <label>
          <span className="sr-only">Find a company</span>
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Find a company"
            className="w-32 rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm"
          />
        </label>
      ) : null}
      <label>
        <span className="sr-only">Company</span>
        <select
          value={value}
          disabled={busy}
          onChange={(e) => choose(e.target.value)}
          className="max-w-[16rem] rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm font-medium text-navy"
        >
          {shown.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
