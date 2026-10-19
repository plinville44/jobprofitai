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
 * A company with a lot of history isn't read in one call: the sync stops
 * between data types when its time runs short and says so (`unfinished`).
 * This keeps calling while it does (runFirstSync), and builds the first brief
 * only once everything is read. Building it from half a read showed costs
 * with no revenue and "completed job with no revenue" warnings, with nothing
 * saying why.
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

/**
 * Sync calls one first run makes at most. Each reads for up to four minutes,
 * so this is about half an hour of reading; anything left after that is read
 * by the nightly sync.
 */
export const FIRST_RUN_MAX_SYNC_CALLS = 8;
/** How many steps a full read has (FULL_SYNC_STEPS in quickbooksSync.ts), when the response doesn't say. */
const DEFAULT_STEPS = 12;
/** Waits between calls are capped, so a long Retry-After can't stall the screen. */
const MAX_WAIT_SECONDS = 60;
/** How long to wait when the nightly sync is carrying on with the same read. */
const BUSY_WAIT_SECONDS = 30;

export const SWITCHED_TO_CUSTOMERS_NOTICE =
  "Your QuickBooks has no Projects or sub-customers, so each customer is read as one job. If a customer has several jobs, add a sub-customer for each, or change how jobs are set up in Settings.";

type Phase =
  | { kind: "idle" }
  | { kind: "syncing"; step?: number; of?: number }
  | { kind: "analyzing"; jobs: number }
  | { kind: "no_jobs" }
  | { kind: "partway" }
  | { kind: "done" }
  | { kind: "failed"; message: string };

export type FirstSyncOutcome =
  | { kind: "failed"; message: string; switched: boolean }
  /** Every step read. */
  | { kind: "finished"; jobs: number; switched: boolean }
  /** Still partway after the last call this screen makes; `jobs` is null if the jobs weren't read yet. */
  | { kind: "unfinished"; jobs: number | null; switched: boolean };

type Post = () => Promise<{ ok: boolean; data: any }>;

/**
 * Calls Sync now until the read is finished, at most `maxCalls` times. Each
 * response with `unfinished` says which steps are left (`remaining`, of
 * `steps`), passed to `onProgress` as the step being read next. A read that
 * is down to once a day (`stuck`) isn't pressed on with.
 *
 * After the first call, a pause (429) or a sync already running (409, the
 * nightly job carrying on with the same read) is waited out and tried again,
 * within the same cap. The first call's 409 is a real "already running" and
 * is shown as such. Pure apart from `post` and `wait`.
 */
export async function runFirstSync(
  post: Post,
  onProgress: (p: { step: number; of: number }) => void = () => {},
  opts: { maxCalls?: number; wait?: (ms: number) => Promise<void> } = {}
): Promise<FirstSyncOutcome> {
  const maxCalls = opts.maxCalls ?? FIRST_RUN_MAX_SYNC_CALLS;
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let switched = false;
  let jobs: number | null = null;
  for (let call = 1; call <= maxCalls; call++) {
    const res = await post();
    if (!res.ok) {
      const code = res.data?.code;
      const retry = call < maxCalls && (code === "sync_cooldown" || (code === "sync_in_progress" && call > 1));
      if (retry) {
        const asked = Number(res.data?.retryAfterSeconds);
        const seconds = code === "sync_cooldown" && asked > 0 ? Math.min(asked, MAX_WAIT_SECONDS) : BUSY_WAIT_SECONDS;
        await wait(seconds * 1000);
        continue;
      }
      return { kind: "failed", message: res.data?.error ?? "We couldn't read your QuickBooks data this time.", switched };
    }
    const d = res.data ?? {};
    if (d.jobSourceAutoSwitched === true) switched = true;
    const remaining: string[] | null = Array.isArray(d.remaining) ? d.remaining : null;
    // Jobs are the first step: once it's done, the count is final.
    if (typeof d.jobs === "number" && !(remaining?.includes("Jobs") ?? false)) jobs = d.jobs;
    if (d.unfinished !== true) return { kind: "finished", jobs: Number(d.jobs ?? 0), switched };
    if (d.stuck === true) break;
    const of = Number(d.steps) > 0 ? Number(d.steps) : DEFAULT_STEPS;
    const left = remaining?.length ?? of;
    onProgress({ step: Math.min(of, Math.max(1, of - left + 1)), of });
  }
  return { kind: "unfinished", jobs, switched };
}

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
  // The first sync chose one customer per job by itself: said once, here.
  const [switched, setSwitched] = useState(false);
  // Effects run twice in development; this keeps it to one real run.
  const started = useRef(false);

  useEffect(() => {
    if (started.current || phase.kind !== "syncing") return;
    started.current = true;

    (async () => {
      try {
        const sync = await runFirstSync(
          () => postJson("/api/quickbooks/sync", connectionId),
          ({ step, of }) => setPhase({ kind: "syncing", step, of })
        );
        setSwitched(sync.switched);
        if (sync.kind === "failed") {
          setPhase({ kind: "failed", message: sync.message });
          return;
        }

        if (sync.jobs === 0) {
          setPhase({ kind: "no_jobs" });
          router.refresh();
          return;
        }

        if (sync.kind === "unfinished") {
          // No brief from half a read: the nightly sync reads the rest.
          setPhase({ kind: "partway" });
          router.refresh();
          return;
        }

        setPhase({ kind: "analyzing", jobs: sync.jobs });
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

  const switchedNote = switched ? (
    <p className="mt-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-navy">{SWITCHED_TO_CUSTOMERS_NOTICE}</p>
  ) : null;

  if (phase.kind === "done") {
    return (
      <div className="mt-4">
        <div className="rounded-lg bg-green-50 px-4 py-3 text-sm text-green-800">
          Your jobs are in, and your first Weekly Profit Brief is ready at the bottom of this page.
        </div>
        {switchedNote}
      </div>
    );
  }

  if (phase.kind === "partway") {
    return (
      <div className="mt-4">
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          We&apos;ve read part of your QuickBooks history. The rest is read automatically overnight, or click &quot;Sync
          now&quot; above to carry on now. Until then some jobs may show costs without their invoices, so your first
          Weekly Profit Brief waits until everything is in: use &quot;Preview this week&apos;s brief&quot; above once
          it is.
        </div>
        {switchedNote}
      </div>
    );
  }

  if (phase.kind === "no_jobs") {
    return (
      <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-900">
        <p>
          QuickBooks is connected, but we didn&apos;t find any customers to read as jobs. JobProfitAI reads each job
          from a QuickBooks Project or sub-customer, a customer if you make one customer per job, or a Class. Add a
          customer, or a sub-customer under it, for each job and pick it on that job&apos;s invoices, bills and
          expenses, then click &quot;Sync now&quot; above. Projects and Classes need QuickBooks Online Plus or
          Advanced. Not sure which fits? Email{" "}
          <a href={`mailto:${SUPPORT_ADDRESS}`} className="font-semibold underline">
            {SUPPORT_ADDRESS}
          </a>
          .
        </p>
      </div>
    );
  }

  if (phase.kind === "failed") {
    return (
      <div className="mt-4">
        <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
          {phase.message} You can also click &quot;Sync now&quot; above.
        </div>
        {switchedNote}
      </div>
    );
  }

  const partway = phase.kind === "syncing" && phase.step != null && phase.of != null;
  const steps = [
    { label: "Reading your jobs, invoices and costs from QuickBooks", active: phase.kind === "syncing", done: phase.kind === "analyzing" },
    { label: "Building your first profit report", active: phase.kind === "analyzing", done: false },
  ];

  return (
    <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-4 text-sm text-navy" role="status" aria-live="polite">
      <p className="font-semibold">
        {partway
          ? "Setting up your dashboard. Your QuickBooks has a lot of history, so this takes a few minutes."
          : "Setting up your dashboard. This usually takes under a minute."}
      </p>
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
      {partway && phase.kind === "syncing" ? (
        <p className="mt-2 text-gray-700">
          Still reading your QuickBooks history, step {phase.step} of {phase.of}.
        </p>
      ) : null}
      <p className="mt-3 text-xs text-gray-500">You can leave this page open. Nothing in QuickBooks is changed.</p>
    </div>
  );
}
