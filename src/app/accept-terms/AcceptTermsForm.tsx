"use client";

import { useState } from "react";
import Link from "next/link";

export default function AcceptTermsForm({ next }: { next: string }) {
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!agreed) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/legal/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acceptTerms: true }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Server returned status ${res.status}.`);
      }
      window.location.href = next;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-4">
      <label className="flex items-start gap-2.5 text-sm text-gray-700">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-gray-300"
        />
        <span>
          I agree to the{" "}
          <Link href="/terms" target="_blank" className="font-medium text-brand underline">
            Terms of Service
          </Link>{" "}
          and{" "}
          <Link href="/privacy" target="_blank" className="font-medium text-brand underline">
            Privacy Policy
          </Link>
          .
        </span>
      </label>
      {error && <p className="text-sm text-red-700">{error}</p>}
      <button
        type="submit"
        disabled={busy || !agreed}
        className="w-full rounded-lg bg-brand px-4 py-2.5 font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
      >
        {busy ? "Saving…" : "Continue"}
      </button>
    </form>
  );
}
