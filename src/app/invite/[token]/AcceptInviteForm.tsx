"use client";

import { useState } from "react";

export default function AcceptInviteForm(
  props: { token: string; mode: "signed_in" } | { token: string; mode: "new_login"; email: string }
) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/team/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(props.mode === "new_login" ? { token: props.token, name, password } : { token: props.token }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Server returned status ${res.status}.`);
      window.location.href = "/dashboard";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-4">
      {props.mode === "new_login" && (
        <>
          <div>
            <label className="block text-sm font-medium text-navy">Email</label>
            <input value={props.email} disabled className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-gray-600" />
          </div>
          <div>
            <label className="block text-sm font-medium text-navy">Your name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-navy">Choose a password</label>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
            />
            <p className="mt-1 text-xs text-gray-500">At least 8 characters.</p>
          </div>
        </>
      )}
      {error && <p className="text-sm text-red-700">{error}</p>}
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-lg bg-brand px-4 py-2.5 font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
      >
        {busy ? "Joining…" : props.mode === "new_login" ? "Create my login and join" : "Accept and join"}
      </button>
    </form>
  );
}
