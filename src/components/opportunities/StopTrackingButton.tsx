"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function StopTrackingButton({ actionId, stopped }: { actionId: string; stopped: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(remove: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/opportunities/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionId, remove }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) setError(data?.error ?? "Couldn't save that.");
      else router.refresh();
    } catch {
      setError("Network error. Please try again.");
    }
    setBusy(false);
  }

  return (
    <div className="flex flex-wrap items-center gap-4 text-xs">
      {!stopped && (
        <button onClick={() => send(false)} disabled={busy} className="font-medium text-gray-600 hover:text-navy disabled:opacity-60">
          Stop tracking
        </button>
      )}
      <button onClick={() => send(true)} disabled={busy} className="font-medium text-gray-400 hover:text-red-700 disabled:opacity-60">
        Remove
      </button>
      {error && <span className="text-red-700">{error}</span>}
    </div>
  );
}
