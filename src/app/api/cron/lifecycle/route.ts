import type Stripe from "stripe";
import { syncAllFirmQuantities } from "@/lib/stripe/firmQuantity";
import { getStripe } from "@/lib/stripe/client";
import { processStripeEvent } from "@/lib/stripe/webhookHandlers";
import { DUPLICATE_OF_METADATA_KEY, isLiveSubscriptionStatus } from "@/lib/stripe/duplicateSubscription";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authorizeCron } from "@/lib/cronAuth";
import { TRIAL_EXTENSION_OFFER_DAY } from "@/lib/plans";
import { computeTrialState, expireFinishedTrials } from "@/lib/trial";
import { purgeExpiredPasswordResets } from "@/lib/passwordReset";
import { purgeExpiredEmailVerifications } from "@/lib/emailVerification";
import { purgeOldLoginAttempts } from "@/lib/loginThrottle";
import { qualifyDueReferrals, retryPendingRewards } from "@/lib/referrals";
import { dueTrialNudges } from "@/lib/trialNudges";
import {
  sendReferralRewardEarned,
  sendReportGuide,
  sendSetupReminder,
  sendTrialCheckIn,
  sendTestimonialRequest,
  sendTrialEndingSoon,
  sendTrialExpired,
} from "@/lib/email/lifecycle";
import { RunErrors, withCronMonitor } from "@/lib/monitoring";
import {
  companiesDueForDeletionReminder,
  deletionDueAt,
  disconnectLapsedCompanies,
  disconnectRevokedGrants,
  purgeDisconnectedCompanies,
  retentionRulesStart,
} from "@/lib/companyData";
import { sendCompanyDeletionReminder, sendLapsedDisconnected } from "@/lib/email/lifecycle";

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

/** A live subscription whose period ended this long ago should have renewed or ended in Stripe by now. */
const STALE_PERIOD_MS = 2 * 86_400_000;
/** Subscriptions read back from Stripe per run, the longest overdue first. */
const RECONCILE_PER_RUN = 25;
/** How many overdue rows are looked at to find those not yet read back today. */
const RECONCILE_CANDIDATES = 500;

interface Counters {
  trialsExpired: number;
  setupReminders: number;
  checkInEmails: number;
  reportGuideEmails: number;
  endingSoonEmails: number;
  expiredEmails: number;
  referralsQualified: number;
  rewardEmails: number;
  strandedRewardsApplied: number;
  testimonialRequests: number;
  passwordResetsPurged: number;
  emailVerificationsPurged: number;
  loginAttemptsPurged: number;
  firmQuantitiesUpdated: number;
  subscriptionsReconciled: number;
  lapsedCompaniesDisconnected: number;
  revokedCompaniesDisconnected: number;
  deletionReminders: number;
  companiesDeleted: number;
  errors: string[];
  /**
   * The run's unexpected errors, sent once it's done as one report for each
   * kind with how many times it happened. One report per trial used up the
   * 20 reports a minute on a fault that hit every row (audit Oct 27, E9).
   */
  faults: RunErrors;
}

export async function GET(req: NextRequest) {
  const auth = authorizeCron(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  // After the check above, so a call that isn't Vercel's never checks in.
  return withCronMonitor("lifecycle", "0 * * * *", runLifecycle);
}

async function runLifecycle() {
  const now = new Date();
  const counters: Counters = {
    trialsExpired: 0,
    setupReminders: 0,
    checkInEmails: 0,
    reportGuideEmails: 0,
    endingSoonEmails: 0,
    expiredEmails: 0,
    referralsQualified: 0,
    rewardEmails: 0,
    strandedRewardsApplied: 0,
    testimonialRequests: 0,
    passwordResetsPurged: 0,
    emailVerificationsPurged: 0,
    loginAttemptsPurged: 0,
    firmQuantitiesUpdated: 0,
    subscriptionsReconciled: 0,
    lapsedCompaniesDisconnected: 0,
    revokedCompaniesDisconnected: 0,
    deletionReminders: 0,
    companiesDeleted: 0,
    errors: [],
    faults: new RunErrors(),
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
  // Firm subscriptions billed for the companies actually connected: puts
  // right any change that didn't reach Stripe when it happened.
  await runStage(counters, "firm-quantities", async () => {
    const r = await syncAllFirmQuantities();
    counters.firmQuantitiesUpdated = r.updated;
    if (r.errors > 0) counters.errors.push(`firm-quantities: ${r.errors} failed`);
  });
  await runStage(counters, "stripe-reconcile", () => reconcileStaleSubscriptions(counters, now));
  // Data retention (src/lib/dataRetention.ts): accounts with no trial or plan
  // for 90 days are disconnected from QuickBooks, so are companies QuickBooks
  // has refused us for 7 days (disconnected on Intuit's side), a disconnected company's
  // owner is reminded a week before its data goes, and data disconnected for
  // 30 days is deleted. Intuit's developer terms require the stop and the
  // deletion; the Terms and Privacy Policy promise these exact steps.
  // The first run records the day the rules started; nothing disconnected or
  // lapsed before that is counted from earlier (retentionRulesStart).
  let rulesStart: Date | null = null;
  await runStage(counters, "retention-start", async () => {
    rulesStart = await retentionRulesStart(now);
  });
  await runStage(counters, "lapsed-disconnect", async () => {
    if (!rulesStart) return;
    const done = await disconnectLapsedCompanies(now, rulesStart);
    counters.lapsedCompaniesDisconnected = done.length;
    const byOwner = new Map<string, typeof done>();
    for (const c of done) byOwner.set(c.userId, [...(byOwner.get(c.userId) ?? []), c]);
    for (const [ownerId, companies] of byOwner) {
      const result = await sendLapsedDisconnected(ownerId, companies, deletionDueAt(now, rulesStart));
      if (!result.ok && !result.skipped) counters.errors.push(`lapsed-disconnect email: ${result.error ?? "failed"}`);
    }
  });
  await runStage(counters, "revoked-grants", async () => {
    // Clamped to the rules' start like the other stages.
    if (!rulesStart) return;
    counters.revokedCompaniesDisconnected = (await disconnectRevokedGrants(now, rulesStart)).length;
  });
  await runStage(counters, "deletion-reminders", async () => {
    if (!rulesStart) return;
    const start: Date = rulesStart;
    for (const c of await companiesDueForDeletionReminder(now, start)) {
      const result = await sendCompanyDeletionReminder(c.userId, c, deletionDueAt(c.disconnectedAt!, start));
      if (result.ok && !result.skipped) counters.deletionReminders += 1;
    }
  });
  await runStage(counters, "purge-disconnected", async () => {
    if (!rulesStart) return;
    counters.companiesDeleted = await purgeDisconnectedCompanies(now, rulesStart);
  });
  // Housekeeping, deliberately last: an expired reset token is already
  // refused on use, so this only stops the table growing forever. It must
  // never be the reason a lifecycle email fails to send.
  await runStage(counters, "password-reset-cleanup", async () => {
    counters.passwordResetsPurged = await purgeExpiredPasswordResets(now);
    counters.emailVerificationsPurged = await purgeExpiredEmailVerifications(now);
    counters.loginAttemptsPurged = await purgeOldLoginAttempts(now);
  });

  await counters.faults.report({ cron: "lifecycle" });
  const { faults: _faults, ...counts } = counters;
  return NextResponse.json({ ok: true, checkedAt: now.toISOString(), ...counts });
}

async function runStage(counters: Counters, name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    // No quotes around the name: the log scrub hides quoted text, and took
    // the stage's name with it (audit Oct 27, SEC4).
    console.error(`cron/lifecycle: stage ${name} failed: ${message}`);
    counters.errors.push(`${name}: ${message}`);
    // A whole stage failing is a fault in our code or the database: each
    // stage handles the email provider's and Stripe's problems itself.
    counters.faults.add(err);
  }
}

/**
 * Trial lifecycle email. Works off the trial state machine in lib/trial.ts
 * rather than re-deriving dates here, so the emails and the entitlement
 * checks can never disagree about whether someone's trial is live.
 */
async function processTrialEmails(counters: Counters, now: Date): Promise<void> {
  // Every live trial, plus trials that expired in the last few days (the
  // "trial ended" email). It used to load 1,000 rows of trialing OR
  // trial_expired in no particular order; expired trials never leave that
  // set, so once there were 1,000 of them new trials stopped getting their
  // emails. Paged, so no count is too many.
  const recentlyExpired = new Date(now.getTime() - 3 * 86_400_000);
  // Only accounts that have verified their address. A signup typo otherwise
  // got a stranger's inbox two weeks of trial emails, and the bounces and
  // complaints count against our sending domain (audit Oct 27, E11). The
  // verification email itself is sent at signup, and the app asks for it.
  const where = {
    OR: [
      { status: "trialing" },
      { status: "trial_expired", trialEndsAt: { gte: recentlyExpired } },
    ],
    user: { emailVerifiedAt: { not: null } },
  };
  const trials: Awaited<ReturnType<typeof prisma.subscription.findMany>> = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await prisma.subscription.findMany({
      where,
      orderBy: { id: "asc" },
      take: 500,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    trials.push(...page);
    if (page.length < 500) break;
    cursor = page[page.length - 1].id;
  }

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

      // 2. Mid-trial check-in and "how to read your numbers" guide, timed
      //    from the first analysis (see lib/trialNudges.ts). These stand in
      //    for the sales call the funnel deliberately does not have.
      const nudges = dueTrialNudges(state, sub.firstAnalysisAt, now);
      if (nudges.checkIn) {
        const result = await sendTrialCheckIn(sub.userId);
        if (result.ok && !result.skipped) counters.checkInEmails++;
      }
      if (nudges.guide) {
        const result = await sendReportGuide(sub.userId);
        if (result.ok && !result.skipped) counters.reportGuideEmails++;
      }

      // 3. Trial ending soon (from day 12). Activated and eligible accounts
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

      // 4. Trial has ended. Keyed to the expiry date, so an extended trial
      //    correctly gets one of these for its new date too.
      if (state.expired && state.trialEndsAt) {
        const result = await sendTrialExpired(sub.userId, state.trialEndsAt);
        if (result.ok && !result.skipped) counters.expiredEmails++;
      }
    } catch (err) {
      counters.errors.push(
        `trial ${sub.userId}: ${err instanceof Error ? err.message : "Unknown error"}`
      );
      // The sends return the email provider's refusals as results, so a
      // throw here is a fault in our code or the database.
      counters.faults.add(err);
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
      counters.faults.add(err);
    }
  }

  // Rewards that were earned but never made it onto a Stripe balance. Run
  // after qualification rather than before, so a reward created moments ago
  // and stranded by a Stripe error is retried on this same tick instead of
  // waiting an hour. The referrer was already emailed when the reward was
  // earned, and that email does not promise a date, so landing the credit
  // late needs no second message.
  counters.strandedRewardsApplied = await retryPendingRewards();
}

/**
 * Subscriptions still live on file well after their period ended, read back
 * from Stripe and put right. Access comes from the stored status, which only
 * Stripe's webhooks change, and an active one is never checked against its
 * period end: when a "subscription deleted" (or the renewal's "updated")
 * webhook was lost, after Stripe's own retries, access stayed on for good
 * (audit Oct 27, B6). What Stripe says now goes through the webhook's own
 * handling (processStripeEvent), as the event that went missing would have:
 * a cancelled one ends access and the owner gets the usual email, a renewed
 * one gets its new period. Its time is when Stripe was read, so a real event
 * from before then can't put back what Stripe no longer says.
 *
 * Since the review of audit Oct 27:
 *  - Before a cancellation is applied, the customer's other subscriptions
 *    are listed, and a live one is applied instead. One that moved to a new
 *    subscription (a plan change made as a new checkout, say) was otherwise
 *    cut off, and emailed that it was cancelled, while paying.
 *  - Each row is read back at most once a day. The event's id is the row's
 *    subscription and the day, recorded by processStripeEvent, or here when
 *    reading it back failed. It used to take the 25 longest overdue every
 *    hour, so rows that never change (an id Stripe doesn't know, an event
 *    the handling leaves alone) were read again every hour, and once there
 *    were 25 of them nobody else was. A run's Stripe errors are reported
 *    once, one report per kind (counters.faults).
 */
async function reconcileStaleSubscriptions(counters: Counters, now: Date): Promise<void> {
  // No Stripe in this environment (development, a preview without billing).
  if (!process.env.STRIPE_SECRET_KEY) return;
  const stale = await prisma.subscription.findMany({
    where: {
      status: { in: ["active", "past_due"] },
      stripeSubscriptionId: { not: null },
      currentPeriodEnd: { lt: new Date(now.getTime() - STALE_PERIOD_MS) },
    },
    select: { userId: true, stripeSubscriptionId: true, stripeCustomerId: true },
    orderBy: { currentPeriodEnd: "asc" },
    take: RECONCILE_CANDIDATES,
  });
  if (stale.length === 0) return;
  const day = now.toISOString().slice(0, 10);
  const idFor = (subscriptionId: string) => `reconcile_${subscriptionId}_${day}`;
  const doneToday = new Set(
    (await prisma.stripeEvent.findMany({ where: { id: { in: stale.map((r) => idFor(r.stripeSubscriptionId!)) } }, select: { id: true } })).map((e) => e.id)
  );
  const due = stale.filter((r) => !doneToday.has(idFor(r.stripeSubscriptionId!))).slice(0, RECONCILE_PER_RUN);
  if (due.length === 0) return;
  const stripe = getStripe();
  // The event the missing webhook would have been, timed when Stripe was read.
  const eventFor = (subscription: Stripe.Subscription, eventId: string) =>
    ({
      id: eventId,
      object: "event",
      type: subscription.status === "canceled" ? "customer.subscription.deleted" : "customer.subscription.updated",
      created: Math.floor(now.getTime() / 1000),
      api_version: null,
      livemode: subscription.livemode,
      pending_webhooks: 0,
      request: null,
      data: { object: subscription },
    }) as unknown as Stripe.Event;
  for (const row of due) {
    const id = idFor(row.stripeSubscriptionId!);
    try {
      const subscription: Stripe.Subscription = await stripe.subscriptions.retrieve(row.stripeSubscriptionId!);
      if (subscription.status === "canceled") {
        // Moved to another subscription that's paying (a plan change made
        // as a new checkout, say)? That one is applied first, and the
        // cancellation only if the row didn't move onto it: a past due or
        // unpaid one, or one the duplicate rule set aside, isn't taken over
        // by the webhook's handling, and the row then stayed "active" on a
        // canceled subscription every day (review of audit Oct 27, B6).
        const customer = row.stripeCustomerId ?? (typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id);
        const others = customer ? (await stripe.subscriptions.list({ customer, status: "all", limit: 20 })).data : [];
        const live = replacement(others, subscription.id, "active");
        if (live) {
          await processStripeEvent(eventFor(live, `${id}_moved`), now);
          const after = await prisma.subscription.findUnique({ where: { userId: row.userId }, select: { stripeSubscriptionId: true } });
          if (after?.stripeSubscriptionId && after.stripeSubscriptionId !== row.stripeSubscriptionId) {
            counters.subscriptionsReconciled++;
            // Read back today; not again until tomorrow.
            await prisma.stripeEvent.create({ data: { id, type: "reconcile.moved", processedAt: now } }).catch(() => {});
            continue;
          }
        }
        // One still live but not active (past due, unpaid, in a Stripe
        // trial) isn't taken over while the row says active, so the
        // cancellation goes first and that one after it, which the webhook's
        // handling then takes onto the canceled row. Otherwise access stayed
        // off until its next change in Stripe, through a trial or the card
        // retries (third review of audit Oct 27).
        const waiting = replacement(others, subscription.id, "live");
        if (waiting) {
          await processStripeEvent(eventFor(subscription, id), now);
          await processStripeEvent(eventFor(waiting, `${id}_moved`), now);
          counters.subscriptionsReconciled++;
          continue;
        }
      }
      const result = await processStripeEvent(eventFor(subscription, id), now);
      if (result.handled && !result.duplicate) counters.subscriptionsReconciled++;
    } catch (err) {
      counters.errors.push(`reconcile ${row.stripeSubscriptionId}: ${err instanceof Error ? err.message : "Unknown error"}`);
      counters.faults.add(err);
      // Not read back again until tomorrow, like one that worked.
      await prisma.stripeEvent.create({ data: { id, type: "reconcile.failed", processedAt: now } }).catch(() => {});
    }
  }
}

/**
 * The customer's subscription, other than `except`, that would be kept on
 * file: active (or, with "live", any status that still bills: active,
 * trialing, past due, unpaid), not one cancelled as a duplicate, and the
 * oldest of those, as the duplicate rule keeps the oldest
 * (duplicateSubscription.ts). Pure.
 */
function replacement(subscriptions: Stripe.Subscription[], except: string, which: "active" | "live"): Stripe.Subscription | null {
  const kept = subscriptions.filter(
    (s) =>
      s.id !== except &&
      (which === "active" ? s.status === "active" : isLiveSubscriptionStatus(s.status)) &&
      !s.metadata?.[DUPLICATE_OF_METADATA_KEY]
  );
  kept.sort((a, b) => (a.created ?? 0) - (b.created ?? 0) || a.id.localeCompare(b.id));
  return kept[0] ?? null;
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
      // Not someone who has just cancelled: still active until the period
      // ends, and asking them for a testimonial then reads badly (audit Oct
      // 27, E12).
      cancelAtPeriodEnd: false,
      firstPaidAt: { not: null, lte: cutoff },
      // Only people who actually use the product - asking someone who never
      // ran an analysis for a testimonial would be absurd.
      activatedAt: { not: null },
      // Not anyone already asked, or who turned tips off (they'd never be
      // sent one): past 200 of those, the same ones came back every hour
      // and nobody new was ever asked.
      user: {
        tipsEmailsOffAt: null,
        emailEvents: { none: { emailType: "testimonial_request", status: "sent" } },
      },
    },
    select: { userId: true },
    // Longest-paying first, in a fixed order.
    orderBy: [{ firstPaidAt: "asc" }, { userId: "asc" }],
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
      counters.faults.add(err);
    }
  }
}
