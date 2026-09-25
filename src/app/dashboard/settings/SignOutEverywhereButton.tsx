"use client";

import { useState } from "react";

/** Signs this login out on every device, this one included. */
export default function SignOutEverywhereButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!window.confirm("Sign out on every device, including this one?")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/logout-all", { method: "POST" });
      if (!res.ok) throw new Error(`Server returned status ${res.status}.`);
      window.location.href = "/login";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
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
        {busy ? "Signing out…" : "Sign out of all devices"}
      </button>
      {error && <span className="text-sm text-red-600">{error}</span>}
    </div>
  );
}
