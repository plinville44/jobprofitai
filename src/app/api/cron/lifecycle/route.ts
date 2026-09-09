import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authorizeCron } from "@/lib/cronAuth";
import { TRIAL_EXTENSION_OFFER_DAY } from "@/lib/plans";
import { computeTrialState, expireFinishedTrials } from "@/lib/trial";
import { purgeExpiredPasswordResets } from "@/lib/passwordReset";
import { qualifyDueReferrals } from "@/lib/referrals";
import {
  sendReferralRewardEarned,
  sendSetupReminder,
  sendTestimonialRequest,
  sendTrialEndingSoon,
  sendTrialExpired,
} from "@/lib/email/lifecycle";

/**
 * GET /api/cron/lifecycle
 *
 * The growth-systems scheduler: trial lifecycle email, trial expiry
 * bookkeeping, and referral reward qualification.
 *
 * Runs on the SAME hourly Vercel Cron schedule the weekly digest already
 * uses (see vercel.json) rather than introducing a second scheduling
 * mechanism. It's a separate endpoint from /api/cron/weekly-email because
 * the two do genuinely unrelated work - mixing "send this contractor's
 * profitability digest" with "expire trials and issue account credits" into
 * one handler would mean a failure in either one could take out the other.
 *
 * SAFE TO RUN REPEATEDLY. Every email goes through sendLifecycleEmail(),
 * whose dedupe key is enforced by a database unique constraint, and reward
 * qualification is guarded by ReferralReward.referralId being unique. Running
 * this endpoint ten times in a row sends nothing twice and issues no
 * duplicate credit.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Days after signup before nudging someone who never connected QuickBooks. */
const SETUP_REMINDER_AFTER_DAYS = 3;

/** How long someone must have been a paying, active customer before we ask
 *  for a testimonial. Three weeks of real usage, per the growth plan - long
 *  enough that they have an honest opinion worth hearing. */
const TESTIMONIAL_AFTER_PAID_DAYS = 21;

interface Counters {
  trialsExpired: number;
  setupReminders: number;
  endingSoonEmails: number;
  expiredEmails: number;
  referralsQualified: number;
  rewardEmails: number;
  testimonialRequests: number;
  passwordResetsPurged: number;
  errors: string[];
}

export async function GET(req: NextRequest) {
  const auth = authorizeCron(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const now = new Date();
  const counters: Counters = {
    trialsExpired: 0,
    setupReminders: 0,
    endingSoonEmails: 0,
    expiredEmails: 0,
    referralsQualified: 0,
    rewardEmails: 0,
    testimonialRequests: 0,
    passwordResetsPurged: 0,
    errors: [],
  };

  // Each stage is independently guarded: one failing stage must not stop the
  // rest of the run, or a single bad row could stall the whole lifecycle
  // indefinitely.
  await runStage(counters, "trial-emails", () => processTrialEmails(counters, now));
  await runStage(counters, "trial-expiry", async () => {
    counters.trialsExpired = await expireFinishedTrials(now);
  });
  await runStage(counters, "referrals", () => processReferralQualification(counters));
  await runStage(counters, "testimonials", () => processTestimonialRequests(counters, now));
  // Housekeeping, deliberately last: an expired reset token is already
  // refused on use, so this only stops the table growing forever. It must
  // never be the reason a lifecycle email fails to send.
  await runStage(counters, "password-reset-cleanup", async () => {
    counters.passwordResetsPurged = await purgeExpiredPasswordResets(now);
  });

  return NextResponse.json({ ok: true, checkedAt: now.toISOString(), ...counters });
}

async function runStage(counters: Counters, name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`cron/lifecycle: stage "${name}" failed: ${message}`);
    counters.errors.push(`${name}: ${message}`);
  }
}

/**
 * Trial lifecycle email. Works off the trial state machine in lib/trial.ts
 * rather than re-deriving dates here, so the emails and the entitlement
 * checks can never disagree about whether someone's trial is live.
 */
async function processTrialEmails(counters: Counters, now: Date): Promise<void> {
  const trials = await prisma.subscription.findMany({
    where: { status: { in: ["trialing", "trial_expired"] } },
    include: { user: { select: { id: true } } },
    take: 1000,
  });

  for (const sub of trials) {
    try {
      const state = computeTrialState(sub, now);

      // 1. Never connected QuickBooks. Explicitly NOT sent to anyone who has
      //    already connected - nudging someone to do a thing they've done is
      //    the fastest way to teach them to ignore your email.
      if (
        state.onTrial &&
        !state.quickbooksConnected &&
        state.dayNumber >= SETUP_REMINDER_AFTER_DAYS
      ) {
        const result = await sendSetupReminder(sub.userId, state.daysRemaining);
        if (result.ok && !result.skipped) counters.setupReminders++;
      }

      // 2. Trial ending soon (from day 12). Activated and eligible accounts
      //    get the feedback-extension offer; everyone else gets the plain
      //    "choose a plan" version.
      if (
        state.onTrial &&
        state.trialEndsAt &&
        state.dayNumber >= TRIAL_EXTENSION_OFFER_DAY &&
        state.daysRemaining <= 3
      ) {
        const result = await sendTrialEndingSoon({
          userId: sub.userId,
          trialEndsAt: state.trialEndsAt,
          daysLeft: state.daysRemaining,
          offerExtension: state.extensionOffered,
          extensionWouldEndAt: state.extensionWouldEndAt,
        });
        if (result.ok && !result.skipped) counters.endingSoonEmails++;
      }

      // 3. Trial has ended. Keyed to the expiry date, so an extended trial
      //    correctly gets one of these for its new date too.
      if (state.expired && state.trialEndsAt) {
        const result = await sendTrialExpired(sub.userId, state.trialEndsAt);
        if (result.ok && !result.skipped) counters.expiredEmails++;
      }
    } catch (err) {
      counters.errors.push(
        `trial ${sub.userId}: ${err instanceof Error ? err.message : "Unknown error"}`
      );
    }
  }
}

/** Issues referral rewards that have completed their 30-day paid window. */
async function processReferralQualification(counters: Counters): Promise<void> {
  const qualified = await qualifyDueReferrals();
  counters.referralsQualified = qualified.length;

  for (const reward of qualified) {
    try {
      const result = await sendReferralRewardEarned({
        referrerUserId: reward.referrerUserId,
        rewardId: reward.rewardId,
        amountCents: reward.amountCents,
        applied: reward.creditApplied,
      });
      if (result.ok && !result.skipped) counters.rewardEmails++;
    } catch (err) {
      counters.errors.push(
        `reward ${reward.rewardId}: ${err instanceof Error ? err.message : "Unknown error"}`
      );
    }
  }
}

/**
 * Testimonial requests. Entirely separate from the trial extension - this
 * asks a genuinely established customer whether they'd be willing to say
 * something, and nothing about their account depends on the answer.
 */
async function processTestimonialRequests(counters: Counters, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - TESTIMONIAL_AFTER_PAID_DAYS * 86_400_000);

  const candidates = await prisma.subscription.findMany({
    where: {
      status: "active",
      firstPaidAt: { not: null, lte: cutoff },
      // Only people who actually use the product - asking someone who never
      // ran an analysis for a testimonial would be absurd.
      activatedAt: { not: null },
    },
    select: { userId: true },
    take: 200,
  });

  for (const candidate of candidates) {
    try {
      const result = await sendTestimonialRequest(candidate.userId);
      if (result.ok && !result.skipped) counters.testimonialRequests++;
    } catch (err) {
      counters.errors.push(
        `testimonial ${candidate.userId}: ${err instanceof Error ? err.message : "Unknown error"}`
      );
    }
  }
}
