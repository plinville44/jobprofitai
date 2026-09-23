import type { TrialState } from "@/lib/trial";

/**
 * When the two mid-trial emails are due.
 *
 * Both are timed from the FIRST ANALYSIS, not from signup. Someone who takes
 * five days to connect QuickBooks should still get "did your jobs show up?"
 * two days after their jobs actually showed up, not on day 3 of a trial
 * where they had nothing to look at yet.
 *
 * Both stop once the trial is inside its last few days. From there the
 * ending-soon email is the one that matters, and three emails in one week is
 * how people learn to ignore all of them. Each is also one per account ever
 * (dedupe key in lib/email/lifecycle.ts), so this only decides WHEN.
 */

/** Days after the first analysis before asking whether the numbers look right. */
export const CHECKIN_AFTER_ANALYSIS_DAYS = 2;

/** Days after the first analysis before the "how to read your numbers" guide. */
export const GUIDE_AFTER_ANALYSIS_DAYS = 6;

/** Neither email goes out once this few days (or fewer) are left. */
export const NUDGE_QUIET_DAYS_LEFT = 3;

const DAY_MS = 86_400_000;

export interface DueNudges {
  checkIn: boolean;
  guide: boolean;
}

export function dueTrialNudges(
  state: Pick<TrialState, "onTrial" | "daysRemaining">,
  firstAnalysisAt: Date | null,
  now: Date = new Date()
): DueNudges {
  if (!state.onTrial || !firstAnalysisAt || state.daysRemaining <= NUDGE_QUIET_DAYS_LEFT) {
    return { checkIn: false, guide: false };
  }
  const daysSinceAnalysis = (now.getTime() - firstAnalysisAt.getTime()) / DAY_MS;
  return {
    checkIn: daysSinceAnalysis >= CHECKIN_AFTER_ANALYSIS_DAYS,
    guide: daysSinceAnalysis >= GUIDE_AFTER_ANALYSIS_DAYS,
  };
}
