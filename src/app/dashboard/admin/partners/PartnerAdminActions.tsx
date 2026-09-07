"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Approve / reject / suspend a partner firm. */
export function PartnerStatusActions({
  partnerId,
  status,
}: {
  partnerId: string;
  status: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "approve" | "reject" | "suspend") {
    if (busy) return;
    // Rejecting or suspending is disruptive and easy to misclick in a table.
    if (action !== "approve" && !window.confirm(`Are you sure you want to ${action} this partner?`)) {
      return;
    }
    setBusy(action);
    setError(null);
    try {
      const res = await fetch("/api/admin/partners", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partnerId, action }),
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
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        {status !== "approved" ? (
          <button
            type="button"
            onClick={() => act("approve")}
            disabled={busy !== null}
            className="rounded-md bg-navy px-2.5 py-1 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-50"
          >
            {busy === "approve" ? "Approving…" : "Approve"}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => act("suspend")}
            disabled={busy !== null}
            className="rounded-md border border-gray-300 px-2.5 py-1 text-xs font-semibold text-gray-700 hover:border-red-400 hover:text-red-700 disabled:opacity-50"
          >
            {busy === "suspend" ? "Suspending…" : "Suspend"}
          </button>
        )}
        {status === "pending" ? (
          <button
            type="button"
            onClick={() => act("reject")}
            disabled={busy !== null}
            className="rounded-md border border-gray-300 px-2.5 py-1 text-xs font-semibold text-gray-700 hover:border-red-400 hover:text-red-700 disabled:opacity-50"
          >
            {busy === "reject" ? "Rejecting…" : "Reject"}
          </button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Marks a partner's outstanding commissions as paid.
 *
 * This records a payout that has already happened outside the system - it
 * does not transfer any money. The button copy says so, because a "Pay"
 * button that doesn't pay would be a genuinely dangerous thing to have in an
 * admin panel.
 */
export function MarkPaidButton({
  commissionIds,
  amountLabel,
}: {
  commissionIds: string[];
  amountLabel: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function markPaid() {
    if (busy || commissionIds.length === 0) return;
    if (
      !window.confirm(
        `Record ${amountLabel} as paid to this partner?\n\nThis marks ${commissionIds.length} commission(s) as settled in the ledger and emails the partner. It does NOT transfer any money. Make the payment separately first.`
      )
    ) {
      return;
    }

    const note = window.prompt("Payment reference or note (optional):") ?? "";

    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/commissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commissionIds, note: note.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Action failed.");
        setBusy(false);
        return;
      }
      router.refresh();
      setBusy(false);
    } catch {
      setError("Couldn't reach the server.");
      setBusy(false);
    }
  }

  if (commissionIds.length === 0) return null;

  return (
    <div>
      <button
        type="button"
        onClick={markPaid}
        disabled={busy}
        className="rounded-md border border-gray-300 px-2.5 py-1 text-xs font-semibold text-gray-700 hover:border-brand hover:text-brand disabled:opacity-50"
      >
        {busy ? "Recording…" : `Record ${amountLabel} as paid`}
      </button>
      {error ? (
        <p role="alert" className="mt-1 text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
