"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Switches the dashboard to this company and opens it. */
export default function OpenCompanyButton({ connectionId, href = "/dashboard", label = "Open" }: { connectionId: string; href?: string; label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function open() {
    setBusy(true);
    try {
      const res = await fetch("/api/company/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId }),
      });
      if (res.ok) {
        router.push(href);
        // A navigation re-renders only the page, not the shared header, so
        // without this the header's company switcher kept naming the company
        // that was on screen before.
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      onClick={open}
      disabled={busy}
      className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-navy hover:bg-gray-50 disabled:opacity-60"
    >
      {busy ? "Opening…" : label}
    </button>
  );
}
