"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

type LinkState = "checking" | "valid" | "invalid";

export default function ResetPasswordForm() {
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";

  // Derived, not set in an effect. A missing token is knowable at first
  // render, so starting in "invalid" avoids a setState inside useEffect and
  // the cascading render that comes with it.
  const [linkState, setLinkState] = useState<LinkState>(token ? "checking" : "invalid");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  // Check the link before showing the form. Letting someone compose a
  // password, submit it, and only then learn the link expired an hour ago is
  // the most annoying possible ordering, and it is entirely avoidable: the
  // GET checks the token without consuming it.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/auth/reset-password?token=${encodeURIComponent(token)}`
        );
        const data = await res.json().catch(() => ({}));
        if (!cancelled) setLinkState(data?.valid ? "valid" : "invalid");
      } catch {
        if (!cancelled) setLinkState("invalid");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Checked here as well as on the server, because this is the one error
    // the customer can fix without a round trip.
    if (password !== confirm) {
      setError("Those two passwords don't match.");
      return;
    }
    if (password.length < 8) {
      setError("Choose a password of at least 8 characters.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
      setDone(true);
      setTimeout(() => router.push("/login"), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  if (linkState === "checking") {
    return (
      <div className="rounded-xl border border-jp-line bg-white p-7 sm:p-8">
        <p className="text-sm text-jp-slate">Checking your link...</p>
      </div>
    );
  }

  if (linkState === "invalid") {
    return (
      <div className="rounded-xl border border-jp-line bg-white p-7 sm:p-8">
        <h1 className="text-xl font-bold text-jp-ink">This link has expired</h1>
        <p className="mt-3 text-sm leading-relaxed text-jp-slate">
          Reset links work once and last an hour. If you requested more than one, only the newest
          one works.
        </p>
        <Link
          href="/forgot-password"
          className="mt-6 inline-block rounded-lg bg-jp-blue px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
        >
          Send a new link
        </Link>
      </div>
    );
  }

  if (done) {
    return (
      <div className="rounded-xl border border-jp-line bg-white p-7 sm:p-8">
        <h1 className="text-xl font-bold text-jp-ink">Password changed</h1>
        <p className="mt-3 text-sm leading-relaxed text-jp-slate">
          Log in with your new password. Taking you there now.
        </p>
        <Link
          href="/login"
          className="mt-6 inline-block text-sm font-medium text-jp-blue hover:underline"
        >
          Log in
        </Link>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-jp-line bg-white p-7 sm:p-8">
      <h1 className="text-xl font-bold text-jp-ink">Choose a new password</h1>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div>
          <label htmlFor="password" className="block text-sm font-medium text-jp-ink">
            New password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border border-jp-line px-3 py-2"
          />
          <p className="mt-1 text-xs text-jp-muted">At least 8 characters.</p>
        </div>

        <div>
          <label htmlFor="confirm" className="block text-sm font-medium text-jp-ink">
            Confirm new password
          </label>
          <input
            id="confirm"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="mt-1 w-full rounded-lg border border-jp-line px-3 py-2"
          />
        </div>

        {error && <p className="text-sm text-red-700">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-jp-blue px-4 py-2 font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? "Saving..." : "Save new password"}
        </button>
      </form>
    </div>
  );
}
