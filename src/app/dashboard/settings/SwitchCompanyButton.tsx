"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** "Show this company" on the Settings companies list. */
export default function SwitchCompanyButton({ connectionId }: { connectionId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function choose() {
    setBusy(true);
    try {
      await fetch("/api/company/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={choose}
      disabled={busy}
      className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
    >
      {busy ? "Switching…" : "Switch to this company"}
    </button>
  );
}
