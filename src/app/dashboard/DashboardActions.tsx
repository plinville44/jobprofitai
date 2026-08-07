"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function DashboardActions({ connectionId }: { connectionId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);

  async function sync() {
    setStatus("Syncing with QuickBooks...");
    const res = await fetch("/api/quickbooks/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionId }),
    });
    const data = await res.json();
    setStatus(
      res.ok
        ? `Synced ${data.jobsSynced} jobs, ${data.purchasesSynced} cost entries, ${data.invoicesSynced} invoices.`
        : `Sync failed: ${data.error}`
    );
    router.refresh();
  }

  async function generateDigest() {
    setStatus("Generating this week's digest...");
    const res = await fetch("/api/digest/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionId }),
    });
    const data = await res.json();
    setStatus(res.ok ? "Digest generated below." : `Digest generation failed: ${data.error}`);
    router.refresh();
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
      {status && <span className="text-sm text-gray-500">{status}</span>}
    </div>
  );
}
