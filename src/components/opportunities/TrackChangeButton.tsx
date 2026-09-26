"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** "I'm making this change": records the baseline so the result can be measured on later jobs. */
export default function TrackChangeButton({ connectionId, itemId }: { connectionId: string; itemId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function track() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/opportunities/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId, itemId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) setError(data?.error ?? `Something went wrong (status ${res.status}).`);
      else router.refresh();
    } catch {
      setError("Network error. Please try again.");
    }
    setBusy(false);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        onClick={track}
        disabled={busy}
        className="rounded-lg bg-navy px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
      >
        {busy ? "Saving..." : "I'm making this change: track the result"}
      </button>
      <span className="text-xs text-gray-500">
        We&apos;ll compare the jobs you set up in QuickBooks from today, as they finish, against the numbers above.
      </span>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </div>
  );
}
