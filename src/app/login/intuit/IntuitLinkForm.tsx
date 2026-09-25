"use client";

import { useState } from "react";
import Link from "next/link";

export default function IntuitLinkForm({ email: initialEmail, canCreate }: { email: string; canCreate: boolean }) {
  const [mode, setMode] = useState<"create" | "link">(canCreate ? "create" : "link");
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Server returned status ${res.status}.`);
      window.location.href = "/dashboard";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      setBusy(false);
    }
  }

  if (mode === "create") {
    return (
      <div className="mt-6 space-y-4">
        <button
          onClick={() => post("/api/auth/intuit/create")}
          disabled={busy}
          className="w-full rounded-lg bg-brand px-4 py-2.5 font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {busy ? "Creating your account…" : "Create my JobProfitAI account"}
        </button>
        <p className="text-xs text-gray-500">
          Starts a 14-day free trial. No card needed. By continuing you agree to the{" "}
          <Link href="/terms" className="underline">
            Terms
          </Link>{" "}
          and{" "}
          <Link href="/privacy" className="underline">
            Privacy Policy
          </Link>
          .
        </p>
        {error && <p className="text-sm text-red-700">{error}</p>}
        <button onClick={() => setMode("link")} className="text-sm font-medium text-brand hover:underline">
          I already have a JobProfitAI login
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        post("/api/auth/intuit/link", { email, password });
      }}
      className="mt-6 space-y-4"
    >
      <div>
        <label className="block text-sm font-medium text-navy">JobProfitAI email</label>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
        />
      </div>
      <div>
        <div className="flex items-baseline justify-between">
          <label className="block text-sm font-medium text-navy">Password</label>
          <Link href="/forgot-password" className="text-sm font-medium text-brand hover:underline">
            Forgot password?
          </Link>
        </div>
        <input
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
        />
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-lg bg-brand px-4 py-2.5 font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
      >
        {busy ? "Linking…" : "Link and sign in"}
      </button>
      {canCreate && (
        <button type="button" onClick={() => setMode("create")} className="text-sm font-medium text-brand hover:underline">
          Create a new account instead
        </button>
      )}
    </form>
  );
}
