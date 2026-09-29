import type { JobSource } from "@/lib/qboNormalize";

/**
 * Rules for how a company's jobs are set up (Projects, one customer per job,
 * or Classes), shared by the dashboard question, the job setup route and the
 * sync. Pure, so they are tested without a database
 * (src/lib/__tests__/jobSetup.test.ts).
 */

/** The dashboard question's answers: "Yes, each job is a class" or "No, keep jobs as they are". */
export type JobSourceAnswer = "classes" | "keep";

export function parseJobSourceAnswer(v: unknown): JobSourceAnswer | null {
  if (v === "classes" || v === "keep") return v;
  // A dashboard opened before "keep" existed sends the setting it loaded
  // with for "No". That always meant "keep what you have", and taking it
  // literally is what put a company back on Projects after its first sync
  // had moved it to one customer per job.
  if (v === "projects" || v === "customers") return "keep";
  return null;
}

export type JobSourceDecision =
  | { ok: true; jobSource: JobSource; rebuild: boolean }
  | { ok: false; status: 409; error: string };

/**
 * What an answer means against the setting stored NOW, not the one the page
 * showed. "Keep" keeps whatever the company has, including a switch to one
 * customer per job that the first sync made after the page loaded.
 */
export function decideJobSourceAnswer(current: string | null | undefined, answer: JobSourceAnswer): JobSourceDecision {
  const stored: JobSource = current === "customers" || current === "classes" ? current : "projects";
  if (answer === "classes") return { ok: true, jobSource: "classes", rebuild: stored !== "classes" };
  if (stored === "classes") {
    // Changed to Classes somewhere else (Settings, another window) since the
    // question was shown. "No" can't say which of the other two to go back
    // to, so nothing is changed.
    return {
      ok: false,
      status: 409,
      error: "Your jobs were just set to come from Classes, in Settings or another window. If your jobs aren't classes, change how your jobs are set up in Settings.",
    };
  }
  return { ok: true, jobSource: stored, rebuild: false };
}

/**
 * The connection fields to write when the job setup changes, on top of the
 * new setting itself.
 *
 *  - lastFullSyncAt and rebuildRequestedAt: the next sync is a full one that
 *    rebuilds the jobs (a sync already running read the old setting and
 *    doesn't count).
 *  - alertsBaselinedAt: the new job rows have new ids, so every condition on
 *    them would look new and be emailed. Cleared, the next alert run records
 *    them without emailing, as it does for a newly connected company.
 *  - basisChangedAt: figures saved before now (weekly snapshots) were worked
 *    out on the old jobs, so they aren't compared as if the jobs changed.
 */
export function jobSetupChangeData(now: Date) {
  return {
    lastFullSyncAt: null,
    rebuildRequestedAt: now,
    alertsBaselinedAt: null,
    basisChangedAt: now,
  };
}

/**
 * Whether a sync may choose the job setup itself (one customer per job, for
 * a company with no Projects). Only on the first sync, and never once the
 * contractor has confirmed a setup: their answer always wins.
 */
export function syncMayPickJobSource(c: { lastSyncedAt: Date | null; jobSourceConfirmedAt: Date | null }): boolean {
  return c.lastSyncedAt == null && c.jobSourceConfirmedAt == null;
}

/** The dashboard question, word for word, so the emails that point to it quote it exactly. */
export const JOB_SOURCE_QUESTION = "Is each job a Class in your QuickBooks?";

/**
 * Whether the dashboard is asking the owner that question: a company that
 * uses Classes, not already reading jobs from them, whose owner hasn't
 * answered. Only once the first sync has finished, because that sync can
 * itself move a company to one customer per job. The "your numbers are in"
 * email and the weekly brief can go out before the answer, so they point to
 * the question while this is true, rather than wait for it.
 */
export function jobSourceQuestionPending(c: {
  lastSyncedAt: Date | null;
  costTrackingMode: string | null;
  jobSource: string | null;
  jobSourceConfirmedAt: Date | null;
}): boolean {
  return c.lastSyncedAt != null && c.costTrackingMode === "classes" && c.jobSource !== "classes" && c.jobSourceConfirmedAt == null;
}
