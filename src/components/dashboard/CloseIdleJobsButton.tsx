"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** One click to mark every idle open job completed (see /api/jobs/close-idle). */
export default function CloseIdleJobsButton({ connectionId, count }: { connectionId: string; count: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/jobs/close-idle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(data.error ?? "Something went wrong. Please try again.");
      } else {
        setMessage(`Marked ${data.updated} ${data.updated === 1 ? "job" : "jobs"} completed.`);
        router.refresh();
      }
    } catch {
      setMessage("We couldn't reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="rounded-lg bg-navy px-4 py-2 text-sm font-semibold text-white hover:bg-brand disabled:opacity-60"
      >
        {busy ? "Marking…" : `Mark ${count === 1 ? "it" : `all ${count}`} completed`}
      </button>
      {message ? <span className="text-sm text-gray-700">{message}</span> : null}
    </div>
  );
}
