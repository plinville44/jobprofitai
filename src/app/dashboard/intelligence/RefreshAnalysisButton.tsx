"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function RefreshAnalysisButton({ connectionId }: { connectionId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setBusy(true);
    setStatus("Checking for new data...");
    try {
      const res = await fetch("/api/analysis/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId }),
      });
      let data: any = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (res.ok) {
        setStatus(data.message ?? (data.refreshed ? `Analysis refreshed - ${data.count} insight(s).` : "Up to date."));
        router.refresh();
      } else {
        setStatus(`Failed: ${data?.error ?? `Server returned status ${res.status}.`}`);
      }
    } catch (err) {
      setStatus(`Failed: ${err instanceof Error ? err.message : "Network error - please try again."}`);
    }
    setBusy(false);
  }

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={refresh}
        disabled={busy}
        className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-navy hover:bg-gray-50 disabled:opacity-60"
      >
        {busy ? "Refreshing..." : "Refresh Analysis"}
      </button>
      {status && <span className="text-sm text-gray-500">{status}</span>}
    </div>
  );
}
