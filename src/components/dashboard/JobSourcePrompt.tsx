"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { JOB_SOURCE_QUESTION } from "@/lib/jobSetup";

/**
 * Asked once, of companies that use QuickBooks Classes: are your jobs your
 * classes, or your customers? Classes are as often divisions or phases as
 * jobs, so this is never switched on without asking.
 *
 * The dashboard shows it only after the first sync has finished, because
 * that sync can itself move a company to one customer per job. "No" sends
 * "keep" and the server keeps whatever is stored then, rather than this
 * page's copy of the setting. "Yes" starts a full sync straight away, so the
 * jobs on screen are the classes now and not after the nightly sync.
 */

type Phase =
  | { kind: "idle" }
  | { kind: "saving" }
  /** waiting: held up by a sync still running, or by the short pause after one (see syncCooldown.ts). */
  | { kind: "syncing"; waiting: false | "sync" | "cooldown" }
  /** The answer was saved but the sync that follows it didn't finish. */
  | { kind: "saved"; message: string }
  | { kind: "error"; message: string };

/**
 * A sync that was already running when "Yes" was clicked read the old
 * setting; this waits for it. The server skips its short pause between
 * syncs for a waiting rebuild, but if it asks for one anyway (a sync that
 * started after the answer was saved has just finished), that's waited out
 * the same way.
 */
const BUSY_RETRIES = 8;
const BUSY_WAIT_MS = 15_000;
/** Longest pause the server asks for (SYNC_COOLDOWN_SECONDS), plus a little. */
const COOLDOWN_WAIT_MAX_MS = 65_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default function JobSourcePrompt({ connectionId, current }: { connectionId: string; current: "projects" | "customers" }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const busy = phase.kind === "saving" || phase.kind === "syncing";

  async function rereadJobs() {
    for (let attempt = 0; attempt <= BUSY_RETRIES; attempt++) {
      const res = await fetch("/api/quickbooks/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        router.refresh();
        return;
      }
      if (res.status === 409 && data?.code === "sync_in_progress" && attempt < BUSY_RETRIES) {
        setPhase({ kind: "syncing", waiting: "sync" });
        await sleep(BUSY_WAIT_MS);
        setPhase({ kind: "syncing", waiting: false });
        continue;
      }
      if (res.status === 429 && data?.code === "sync_cooldown" && attempt < BUSY_RETRIES) {
        const seconds = Number(data?.retryAfterSeconds ?? res.headers.get("Retry-After"));
        const waitMs = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000 + 1_000, COOLDOWN_WAIT_MAX_MS) : COOLDOWN_WAIT_MAX_MS;
        setPhase({ kind: "syncing", waiting: "cooldown" });
        await sleep(waitMs);
        setPhase({ kind: "syncing", waiting: false });
        continue;
      }
      setPhase({
        kind: "saved",
        message:
          res.status === 409
            ? "Saved. Another sync is still running, so your jobs will be read again as classes at the next sync. Click Sync now above in a few minutes to do it sooner."
            : res.status === 429 && data?.code === "sync_cooldown"
              ? "Saved. Your jobs will be read again as classes at the next sync. Click Sync now above in a minute to do it sooner."
              : `Saved, but reading your jobs from QuickBooks didn't finish. ${data?.error ?? "Please try again."} Click Sync now above to try again.`,
      });
      return;
    }
  }

  async function answer(jobSource: "classes" | "keep") {
    setPhase({ kind: "saving" });
    try {
      const res = await fetch("/api/settings/job-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId, jobSource }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setPhase({ kind: "error", message: data?.error ?? "Couldn't save that. Please try again." });
        return;
      }
      if (!data?.rebuild) {
        router.refresh();
        return;
      }
    } catch {
      setPhase({ kind: "error", message: "Network error. Please try again." });
      return;
    }
    setPhase({ kind: "syncing", waiting: false });
    try {
      await rereadJobs();
    } catch {
      setPhase({
        kind: "saved",
        message:
          "Saved. The connection dropped while your jobs were being read again, so they may not show as classes yet. Refresh this page in a minute, or click Sync now above.",
      });
    }
  }

  if (phase.kind === "saved") {
    return (
      <section className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900" role="status">
        {phase.message}
      </section>
    );
  }

  if (phase.kind === "syncing") {
    return (
      <section className="mt-6 rounded-xl border border-blue-200 bg-blue-50 p-5 text-sm text-navy" role="status" aria-live="polite">
        <p className="font-semibold">Saved. Reading your jobs from QuickBooks again, this time from your classes.</p>
        <p className="mt-1 text-gray-700">
          {phase.waiting === "sync"
            ? "A sync that started before your answer is still running. Yours starts as soon as it finishes."
            : phase.waiting === "cooldown"
              ? "Your QuickBooks data was read a moment ago. Yours starts in under a minute."
              : "This usually takes under a minute. Leave this page open and your jobs will appear here."}
        </p>
      </section>
    );
  }

  return (
    <section className="mt-6 rounded-xl border border-brand/30 bg-brand-light/40 p-5">
      <h2 className="text-base font-semibold text-navy">{JOB_SOURCE_QUESTION}</h2>
      <p className="mt-1 max-w-3xl text-sm text-gray-700">
        Your company uses QuickBooks Classes. Some contractors make a class for each job and pick it on every bill,
        expense, time entry and invoice; others use classes for divisions or phases and keep jobs as customers. Right
        now your jobs are read from {current === "customers" ? "your customers (one customer per job)" : "your Projects and sub-customers"}.
      </p>
      <div className="mt-3 flex flex-wrap gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => answer("classes")}
          className="rounded-lg bg-navy px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
        >
          Yes, each job is a class
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => answer("keep")}
          className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-navy hover:bg-gray-50 disabled:opacity-60"
        >
          No, keep jobs as they are
        </button>
      </div>
      <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
        Choosing classes reads your jobs from QuickBooks again straight away. Jobs that aren&apos;t classes are removed,
        along with the job type, estimate and contract value typed in for them. You can change this any time in Settings.
      </p>
      {phase.kind === "error" ? <p className="mt-2 text-sm text-red-700">{phase.message}</p> : null}
    </section>
  );
}
