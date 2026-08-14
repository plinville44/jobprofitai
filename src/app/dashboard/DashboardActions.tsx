"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function DashboardActions({ connectionId }: { connectionId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);

  // Shared fetch wrapper: guarantees `status` always ends up with a real
  // message. Without this, a network error, a timeout, or the server
  // returning a non-JSON error page (e.g. Vercel's default 500 HTML page)
  // would throw inside res.json() and leave the button stuck on its
  // "Syncing..." / "Generating..." message forever with no way to tell
  // whether it failed or is still running.
  async function callApi(url: string, busyMessage: string, onSuccess: (data: any) => string) {
    setStatus(busyMessage);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId }),
      });

      let data: any = null;
      try {
        data = await res.json();
      } catch {
        // Response wasn't JSON (e.g. a raw error page or timeout page).
        data = null;
      }

      if (res.ok && data) {
        setStatus(onSuccess(data));
      } else {
        setStatus(`Failed: ${data?.error ?? `Server returned status ${res.status}. Check Vercel logs.`}`);
      }
    } catch (err) {
      setStatus(`Failed: ${err instanceof Error ? err.message : "Network error - please try again."}`);
    }
    router.refresh();
  }

  function sync() {
    return callApi(
      "/api/quickbooks/sync",
      "Syncing with QuickBooks...",
      (data) => {
        const costEntries = (data.purchases ?? 0) + (data.bills ?? 0) + (data.timeActivities ?? 0);
        const base = `Synced ${data.jobs ?? 0} jobs, ${costEntries} cost entries, ${data.invoices ?? 0} invoices, ${data.estimates ?? 0} estimates.`;
        // partialErrors means some new-this-phase entity types (Bill/TimeActivity/
        // Estimate) couldn't be pulled, but everything else synced fine - surfaced
        // here rather than hidden, so a problem is visible without digging into Neon.
        if (data.partialErrors && Object.keys(data.partialErrors).length > 0) {
          return `${base} Note: couldn't sync ${Object.keys(data.partialErrors).join(", ")} this time — everything else synced fine.`;
        }
        return base;
      }
    );
  }

  function generateDigest() {
    return callApi(
      "/api/digest/generate",
      "Generating this week's digest...",
      () => "Digest generated below."
    );
  }

  function disconnect() {
    if (
      !window.confirm(
        "Disconnect this QuickBooks company? You'll need to reconnect to get new digests."
      )
    ) {
      return;
    }
    return callApi(
      "/api/quickbooks/disconnect",
      "Disconnecting from QuickBooks...",
      () => "Disconnected."
    );
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <button
        onClick={sync}
        className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-navy hover:bg-gray-50"
      >
        Sync now
      </button>
      <button
        onClick={generateDigest}
        className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
      >
        Generate this week&apos;s digest
      </button>
      <button
        onClick={disconnect}
        className="rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
      >
        Disconnect
      </button>
      {status && <span className="text-sm text-gray-500">{status}</span>}
    </div>
  );
}
