"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Deletes one company's data now (POST /api/quickbooks/delete-company),
 * leaving the account and its other companies alone. Asks for the password
 * and the word DELETE, like deleting the account.
 */
export default function DeleteCompanyForm({ connectionId, companyName }: { connectionId: string; companyName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/quickbooks/delete-company", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId, password, confirm }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        setOpen(false);
        router.refresh();
        return;
      }
      setError(data?.error ?? `Couldn't delete it (status ${res.status}).`);
    } catch {
      setError("Network error. Nothing was deleted. Try again in a minute.");
    }
    setBusy(false);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
      >
        Delete this company&apos;s data
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="mt-3 w-full space-y-3 rounded-lg border border-red-100 bg-red-50/40 p-4">
      <p className="text-sm text-gray-700">
        This permanently deletes everything JobProfitAI copied or calculated for {companyName}: jobs, costs, time,
        invoices, estimates, weekly briefs, alerts, insights, WIP snapshots and its settings. Its client logins lose
        access. It disconnects QuickBooks if it&apos;s still connected. Your account and your other companies aren&apos;t
        touched. It can&apos;t be undone.
      </p>
      <label className="block text-sm">
        <span className="text-gray-700">Your password</span>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
          required
        />
      </label>
      <label className="block text-sm">
        <span className="text-gray-700">Type DELETE to confirm</span>
        <input
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
          required
        />
      </label>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={busy || confirm !== "DELETE" || password.length === 0}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
        >
          {busy ? "Deleting..." : "Delete permanently"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
