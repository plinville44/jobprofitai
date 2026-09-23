"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Runs the first sync and first analysis on its own, right after a company
 * is connected.
 *
 * Before this, a new trial connected QuickBooks and landed on a dashboard of
 * zeros with a note saying to click "Sync now", then a second button to see
 * a brief. With no sales call to walk anyone through it, that was the step
 * where a self-serve trial was most likely to stall. Seeing their own jobs is
 * the moment people decide to pay, so it happens without asking.
 *
 * It calls the same two endpoints the dashboard buttons call, so it carries
 * the same session, ownership and entitlement checks, and completing the
 * analysis also fires the one-time "your numbers are in" email.
 *
 * Starts only while the connection has never synced (`neverSynced`). The
 * page keeps this mounted for the whole connect visit (?qbo_connected=1), so
 * the router.refresh() that brings the new numbers in, which also makes
 * `neverSynced` false, does not unmount it and swallow the result message.
 * Mounted fresh on an already-synced company, it renders nothing and calls
 * nothing. Re-running it (a refresh mid-sync, two tabs) is harmless: sync
 * upserts, and the brief for a given week is one row.
 */

// Matches the address the dashboard footer shows. The server-side
// SUPPORT_EMAIL lives next to the Resend client, which a client component
// must not import.
const SUPPORT_ADDRESS = "support@jobprofitai.com";

type Phase =
  | { kind: "idle" }
  | { kind: "syncing" }
  | { kind: "analyzing"; jobs: number }
  | { kind: "no_jobs" }
  | { kind: "done" }
  | { kind: "failed"; message: string };

async function postJson(url: string, connectionId: string): Promise<{ ok: boolean; data: any }> {
  const res = await fetch(url, {
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
  return { ok: res.ok && data != null, data };
}

export default function FirstRunSetup({
  connectionId,
  neverSynced,
}: {
  connectionId: string;
  neverSynced: boolean;
}) {
  const router = useRouter();
  // Decided once, at mount: a later refresh flipping neverSynced to false
  // must not reset what this instance is showing.
  const [phase, setPhase] = useState<Phase>(() => (neverSynced ? { kind: "syncing" } : { kind: "idle" }));
  // Effects run twice in development; this keeps it to one real run.
  const started = useRef(false);

  useEffect(() => {
    if (started.current || phase.kind !== "syncing") return;
    started.current = true;

    (async () => {
      try {
        const sync = await postJson("/api/quickbooks/sync", connectionId);
        if (!sync.ok) {
          setPhase({
            kind: "failed",
            message: sync.data?.error ?? "We couldn't read your QuickBooks data this time.",
          });
          return;
        }

        const jobs = Number(sync.data?.jobs ?? 0);
        if (jobs === 0) {
          setPhase({ kind: "no_jobs" });
          router.refresh();
          return;
        }

        setPhase({ kind: "analyzing", jobs });
        const brief = await postJson("/api/digest/generate", connectionId);
        if (!brief.ok) {
          // The jobs are in, which is most of the value; the brief can be
          // made from the button later. Refresh so the numbers show.
          setPhase({
            kind: "failed",
            message:
              brief.data?.error ??
              "Your jobs are in, but the first Weekly Profit Brief didn't finish. Use \"Preview this week's brief\" above to try again.",
          });
          router.refresh();
          return;
        }

        setPhase({ kind: "done" });
        router.refresh();
      } catch (err) {
        setPhase({
          kind: "failed",
          message: err instanceof Error ? err.message : "Network error. Please try again.",
        });
      }
    })();
    // Runs once per mount by design; phase changes must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, router]);

  if (phase.kind === "idle") return null;

  if (phase.kind === "done") {
    return (
      <div className="mt-4 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-800">
        Your jobs are in, and your first Weekly Profit Brief is ready at the bottom of this page.
      </div>
    );
  }

  if (phase.kind === "no_jobs") {
    return (
      <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-900">
        <p className="font-semibold">QuickBooks is connected, but we didn&apos;t find any jobs yet.</p>
        <p className="mt-2">
          JobProfitAI reads jobs from QuickBooks <strong>Projects</strong>. If Projects isn&apos;t turned
          on, open QuickBooks Online, go to <strong>Settings, Account and settings, Advanced</strong>,
          turn on <strong>Projects</strong>, then create a project for each job and tag its invoices
          and costs to it. Then click &quot;Sync now&quot; above.
        </p>
        <p className="mt-2">
          Track jobs another way, such as by Class? Email{" "}
          <a href={`mailto:${SUPPORT_ADDRESS}`} className="font-semibold underline">
            {SUPPORT_ADDRESS}
          </a>{" "}
          and we&apos;ll help you work out the best setup.
        </p>
      </div>
    );
  }

  if (phase.kind === "failed") {
    return (
      <div className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
        {phase.message} You can also click &quot;Sync now&quot; above.
      </div>
    );
  }

  const steps = [
    { label: "Reading your jobs, invoices and costs from QuickBooks", active: phase.kind === "syncing", done: phase.kind === "analyzing" },
    { label: "Building your first profit report", active: phase.kind === "analyzing", done: false },
  ];

  return (
    <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-4 text-sm text-navy" role="status" aria-live="polite">
      <p className="font-semibold">Setting up your dashboard. This usually takes under a minute.</p>
      <ol className="mt-3 space-y-1.5">
        {steps.map((step) => (
          <li key={step.label} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={`inline-block h-2.5 w-2.5 rounded-full ${
                step.done ? "bg-green-600" : step.active ? "animate-pulse bg-brand" : "bg-gray-300"
              }`}
            />
            <span className={step.active ? "font-medium" : step.done ? "text-gray-600" : "text-gray-400"}>
              {step.label}
              {step.done && phase.kind === "analyzing" ? ` (${phase.jobs} ${phase.jobs === 1 ? "job" : "jobs"} found)` : ""}
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs text-gray-500">You can leave this page open. Nothing in QuickBooks is changed.</p>
    </div>
  );
}
