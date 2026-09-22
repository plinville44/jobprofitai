"use client";

import { useState } from "react";

/**
 * Permanent account deletion, self-service.
 *
 * The route (/api/account/delete) existed and the security page and
 * privacy policy both said you could delete your account from Settings, but
 * nothing on any screen called it. Deletion is irreversible, so it asks for
 * the password and the word DELETE, the same two things the route checks.
 */
export default function DeleteAccountForm() {
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
      const res = await fetch("/api/account/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, confirm }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        window.location.href = "/?account_deleted=1";
        return;
      }
      setError(data?.error ?? `Couldn't delete the account (status ${res.status}).`);
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
        Delete my account
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-sm text-gray-700">
        This permanently deletes your account and everything synced or calculated from your
        QuickBooks data: jobs, costs, invoices, weekly briefs, insights and settings. It
        disconnects QuickBooks and cancels any subscription. It can&apos;t be undone.
      </p>
      <div>
        <label htmlFor="delete-password" className="block text-sm font-medium text-navy">
          Your password
        </label>
        <input
          id="delete-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full max-w-sm rounded-lg border border-gray-300 px-3 py-2 text-sm"
          required
        />
      </div>
      <div>
        <label htmlFor="delete-confirm" className="block text-sm font-medium text-navy">
          Type DELETE to confirm
        </label>
        <input
          id="delete-confirm"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="mt-1 w-full max-w-sm rounded-lg border border-gray-300 px-3 py-2 text-sm"
          autoComplete="off"
          required
        />
      </div>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={busy || confirm !== "DELETE" || !password}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
        >
          {busy ? "Deleting..." : "Permanently delete my account"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="text-sm text-gray-600 hover:underline"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
