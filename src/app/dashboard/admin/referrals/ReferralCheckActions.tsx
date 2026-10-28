"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The decision on a referral held for a check (its account's email address
 * was first proven by a password reset). Used on the Referrals tab and
 * beside the held amount on the Partners tab. See decideHeldReferral in
 * src/lib/referrals.ts for what each one does.
 */
export function ReferralCheckActions({ referralId }: { referralId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"clear" | "disqualify" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "clear" | "disqualify") {
    if (busy) return;
    const question =
      action === "clear"
        ? "Mark this referral as checked and fine? Its reward or commission can then be paid as usual."
        : "Disqualify this referral? It earns nothing from now on, and commission on it that hasn't been paid out is voided.";
    if (!window.confirm(question)) return;
    setBusy(action);
    setError(null);
    try {
      const res = await fetch("/api/admin/referrals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ referralId, action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Action failed.");
        setBusy(null);
        return;
      }
      router.refresh();
      setBusy(null);
    } catch {
      setError("Couldn't reach the server.");
      setBusy(null);
    }
  }

  return (
    <div className="mt-1.5 space-y-1">
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => act("clear")}
          disabled={busy !== null}
          className="rounded-md bg-navy px-2.5 py-1 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-50"
        >
          {busy === "clear" ? "Saving…" : "Looks fine"}
        </button>
        <button
          type="button"
          onClick={() => act("disqualify")}
          disabled={busy !== null}
          className="rounded-md border border-gray-300 px-2.5 py-1 text-xs font-semibold text-gray-700 hover:border-red-400 hover:text-red-700 disabled:opacity-50"
        >
          {busy === "disqualify" ? "Disqualifying…" : "Disqualify"}
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
