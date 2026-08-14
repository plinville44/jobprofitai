"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * QuickBooks connection management for the Settings page - just Disconnect
 * now. Sync now / Generate this week's digest deliberately stay on the main
 * dashboard (see DashboardActions.tsx); this component only owns the action
 * that was relocated here per the Phase 5 plan.
 */
export default function ConnectionActions({ connectionId }: { connectionId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function disconnect() {
    if (
      !window.confirm(
        "Disconnect this QuickBooks company? You'll need to reconnect to get new digests and syncs."
      )
    ) {
      return;
    }
    setBusy(true);
    setStatus("Disconnecting from QuickBooks...");
    try {
      const res = await fetch("/api/quickbooks/disconnect", {
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
        setStatus("Disconnected.");
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
    <div className="mt-4 flex items-center gap-3">
      <button
        onClick={disconnect}
        disabled={busy}
        className="rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-60"
      >
        Disconnect
      </button>
      {status && <span className="text-sm text-gray-500">{status}</span>}
    </div>
  );
}
