"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * QuickBooks connection management for the Settings page - just Disconnect
 * now. Sync now / Generate this week's digest deliberately stay on the main
 * dashboard (see DashboardActions.tsx); this component only owns the action
 * that was relocated here per the Phase 5 plan.
 */
export default function ConnectionActions({
  connectionId,
  companyName,
  clientLogins = 0,
  firmBilled = false,
}: {
  connectionId: string;
  companyName: string;
  /** Client logins (active or invited) for this company. */
  clientLogins?: number;
  /** A paid Firm plan, billed per connected company. */
  firmBilled?: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function disconnect() {
    if (!window.confirm(disconnectQuestion(companyName, clientLogins, firmBilled))) {
      return;
    }
    setBusy(true);
    setStatus("Disconnecting from QuickBooks...");
    try {
      const res = await fetch("/api/quickbooks/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId }),
      });
      let data: any = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (res.ok) {
        setStatus("Disconnected.");
        router.refresh();
      } else {
        setStatus(`Failed: ${data?.error ?? `Server returned status ${res.status}.`}`);
      }
    } catch (err) {
      setStatus(`Failed: ${err instanceof Error ? err.message : "Network error. Please try again."}`);
    }
    setBusy(false);
  }

  return (
    <div className="mt-4 flex items-center gap-3">
      <button
        onClick={disconnect}
        disabled={busy}
        className="rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-60"
      >
        Disconnect from QuickBooks
      </button>
      {status && <span className="text-sm text-gray-500">{status}</span>}
    </div>
  );
}

/**
 * What the owner is agreeing to. Says who else loses access and that the
 * bill changes, since neither is obvious from "disconnect".
 */
function disconnectQuestion(companyName: string, clientLogins: number, firmBilled: boolean): string {
  const parts = [
    `Disconnect ${companyName} from QuickBooks? Syncing, its Weekly Profit Brief and its alerts stop. Your existing data is kept.`,
  ];
  if (clientLogins > 0) {
    parts.push(
      `${clientLogins === 1 ? "Its client login loses" : `Its ${clientLogins} client logins lose`} access now. Reconnecting later doesn't give it back; you'd invite them again.`
    );
  }
  if (firmBilled) {
    parts.push("On the Firm plan you're billed for each connected company (4 at least), so this can lower your bill.");
  }
  return parts.join("\n\n");
}
