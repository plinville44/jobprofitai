"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function UnlinkIntuitButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!window.confirm("Turn off Sign in with Intuit? You'll sign in with your email and password.")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/intuit/unlink", { method: "POST" });
      if (!res.ok) throw new Error(`Server returned status ${res.status}.`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        onClick={run}
        disabled={busy}
        className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
      >
        {busy ? "Turning off…" : "Turn off Sign in with Intuit"}
      </button>
      {error && <span className="text-sm text-red-600">{error}</span>}
    </div>
  );
}
